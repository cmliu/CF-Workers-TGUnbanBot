// Telegram Bot Token
let BOT_TOKEN;
// 群组ID
let GROUP_ID;
// 机器人用户名缓存
let BOT_USERNAME = null;
let BOT_ID = null;
// 群组信息缓存
let GROUP_TITLE = null;
let GROUP_USERNAME = null;

// ========================================================
// 隐藏 /ad 举报投票功能
// ========================================================
// 概要:
// - 管理员在 GROUP_ID 群内回复消息(或带参数)发送 /ad,发起一次隐藏的举报投票。
// - 回复场景:把被举报内容发给 Workers AI(模型由 AD_AI_MODEL 配置,默认 @cf/openai/gpt-oss-20b),
//   由 AI 按群规判断威胁评级(0~100 分),评级决定本次投票的生效阈值:
//     🔴A 高危 = 2 票  🟠B 危险 = 4 票  🟡C 可疑 = 6 票  🔵D 未知 = 8 票
//   AI 同时给出简短理由说明,仅记录在 Workers 日志中,不展示在投票消息里。
// - 直接 /ad <tgid>(无回复内容)/ 无文字内容 / AI 基础设施失败(未绑定/超时/异常)→ 回退 🟡C 可疑(6 票)。
// - AI 有响应但无法识别/拒绝答复(空响应、格式不对、可能触发安全策略拒答)→ 按 🟠B 危险(4 票)处理。
// - 群规由 AD_GROUP_RULES 变量规定(env 可覆盖),默认"禁止讨论涉及涉政、NSFW、引战、嘲讽引战、广告推销、邪教"。
// - 投票状态持久化到 env.KV: key = ad_vote:<vote_token>, TTL 7 天。
// - 结束时调用 editMessageText 移除按钮,若赞成胜出则触发封禁(写入 KV 黑名单 + 群内禁言)。
// - /ad 不出现在 setMyCommands 命令菜单中(保持隐藏)。
// - 非管理员(含普通用户)触发 /ad:助推者/白名单直接发起投票;普通用户回复消息 + /ad 时内容交 AI 评级,仅 A/B 弹投票,C/D 或 AI 失败完全静默,均不发权限提示。
// ========================================================

// 回退阈值:AI 不可用 / 直接传 tgid / 无文字内容时使用(默认 C 可疑 6 票)
let AD_VOTE_THRESHOLD = 6;
// 群规文本:发给 AI 判断威胁等级的依据,env.AD_GROUP_RULES 可覆盖
let AD_GROUP_RULES = '禁止讨论涉及涉政、NSFW、引战、嘲讽引战、广告推销、邪教';
const AD_VOTE_TTL_SECONDS = 7 * 24 * 60 * 60;
const AD_VOTE_DURATION_HOURS = 1; // 仅用于显示截止时间,非强制过期
const AD_VOTE_BUTTON_PREFIX = 'adv:'; // callback_data 前缀
// 反对票阈值基数:反对阈值 = 10 - 赞成阈值
const AD_VOTE_MAX_VOTES = 10;

// ---- AI 威胁评级配置(env 均可覆盖) ----
// 主模型:可用 env.AD_AI_MODEL 覆盖(如 @cf/qwen/qwen3-30b-a3b-fp8)。
// 默认 @cf/openai/gpt-oss-20b:实测延迟约 2s,稳定性好;此前默认的
// @cf/zai-org/glm-4.7-flash 在部分账号/区域持续超时(>12s 无响应)。
let AD_AI_MODEL = '@cf/openai/gpt-oss-20b';
let AD_AI_TIMEOUT_MS = 12000; // 单次调用超时,超时/异常回退 C 可疑(12s + 发送消息 < Worker 30s 墙钟上限)
const AD_AI_MAX_CONTENT_CHARS = 500; // 发送给 AI 的被举报内容最大长度
// 评级表:分数区间决定评级,评级决定本次投票生效阈值
const AD_THREAT_RATINGS = {
	A: { level: 'A', emoji: '🔴', label: '🔴 A 高危', minScore: 81, maxScore: 100, votes: 2 },
	B: { level: 'B', emoji: '🟠', label: '🟠 B 危险', minScore: 61, maxScore: 80, votes: 4 },
	C: { level: 'C', emoji: '🟡', label: '🟡 C 可疑', minScore: 31, maxScore: 60, votes: 6 },
	D: { level: 'D', emoji: '🔵', label: '🔵 D 未知', minScore: 0, maxScore: 30, votes: 8 }
};

// 黑名单实例级内存缓存:短 TTL 降低 KV 读频率,避免逼近 KV 免费档读取上限
const BLACKLIST_CACHE_TTL_MS = 5000; // 5 秒,写入后跨实例最长延迟
let blacklistCache = { data: null, fetchedAt: 0 };

// ========================================================
// D1 数据库层(数据访问 + KV→D1 自动迁移)
// [DB-LAYER-START] 边界标记,QA 切片依赖,勿改动此行
// ========================================================
// 说明:
// - 绑定 D1(env.DB)后黑名单/白名单/用户记录优先走数据库;未绑定自动回退旧 KV 逻辑(向下兼容)。
// - 首个请求惰性建表 + 检测 KV 是否还有未导入数据,有则自动导入一次(幂等,并发安全)。
// - users 表以 tgid 为唯一标识,记录所有收到消息的用户:资料快照 / 最后对话时间 /
//   活跃群组数组(元素 {id, status},status 三态:健康/禁言/封禁) / 黑名单状态与原因时间 /
//   举报资格(/add_ad_admin) / 消息计数。
// - ad_vote:<token> 投票状态仍存 KV:利用 TTL 自动过期,D1 无 TTL 需额外清理逻辑。

// 建表 SQL:幂等 CREATE TABLE IF NOT EXISTS,首次请求执行。
const DB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  tgid TEXT PRIMARY KEY,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  is_bot INTEGER NOT NULL DEFAULT 0,
  is_blacklisted INTEGER NOT NULL DEFAULT 0,
  ban_reason TEXT NOT NULL DEFAULT '',
  banned_at INTEGER NOT NULL DEFAULT 0,
  banned_by TEXT NOT NULL DEFAULT '',
  can_report INTEGER NOT NULL DEFAULT 0,
  is_gky_blacklisted INTEGER NOT NULL DEFAULT 0,
  last_active_at INTEGER NOT NULL DEFAULT 0,
  active_group_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT 0,
  last_unban_at INTEGER NOT NULL DEFAULT 0,
  unbanned_by TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
// schema_meta 中 KV 导入完成标记 key
const DB_KV_IMPORT_KEY = 'kv_imported_v1';
// 迁移锁租约:持锁实例崩溃/被回收时,锁超龄后由其他实例清除并重新抢锁,避免迁移永久停滞
const DB_MIGRATE_LOCK_TTL_SECONDS = 120;
// 迁移等待上限:未持锁实例轮询等待迁移者完成的最长时间(ms)
const DB_MIGRATE_WAIT_MS = 2000;
// KV 导入黑名单时缺失的时间字段默认值:0 表示"未知",避免 NULL 造成数据错误
const DB_DEFAULT_UNKNOWN_TIME = 0;
// 黑名单原因映射:source → ban_reason(/ad=举报,/spam 与 /ban=管理员封禁,细分来源便于追溯)
const DB_BAN_REASON_MAP = {
	ad: '举报',
	spam: '管理员封禁(/spam)',
	ban: '管理员封禁(/ban)'
};

// 用户在群组内的健康状态(active_group_ids 数组元素 status 字段取值):
// 管理员=群主/管理员(可发言,豁免黑名单), 健康=普通正常成员(可发言),
// 禁言=被 restrictChatMember 禁发消息, 封禁=被 banChatMember 踢出群组(含被踢后尚未重新加入)。
const GROUP_MEMBER_STATUS = {
	ADMIN: '管理员',
	HEALTHY: '健康',
	MUTED: '禁言',
	BANNED: '封禁',
	WHITELISTED: '白名单'
};

// 群组管理员判定钩子(黑名单豁免 / 管理员状态标记用):
// DB 层不直接调用 Telegram API(保持 QA 沙箱可测),由业务层在模块加载时注入真实检查器。
// 未注入(null)时一律按"非管理员"处理:QA 沙箱与纯 DB 层场景行为稳定。
let groupAdminChecker = null;
function setGroupAdminChecker(fn) {
	groupAdminChecker = typeof fn === 'function' ? fn : null;
}
// 同步判断某 tgid 是否为 GROUP_ID 群管理员(钩子未注入时恒 false,不抛错)
async function isGroupAdmin(tgid) {
	if (!groupAdminChecker) return false;
	try {
		return Boolean(await groupAdminChecker(tgid));
	} catch (error) {
		console.error('[DB] 管理员判定钩子调用失败(按非管理员处理):', error.message);
		return false;
	}
}

// 归一化群组状态:仅接受 管理员/健康/禁言/封禁/白名单,其余一律回退 健康(未知状态按正常处理,不误标)。
function normalizeGroupStatus(status) {
	if (status === GROUP_MEMBER_STATUS.ADMIN
		|| status === GROUP_MEMBER_STATUS.MUTED
		|| status === GROUP_MEMBER_STATUS.BANNED
		|| status === GROUP_MEMBER_STATUS.WHITELISTED) {
		return status;
	}
	return GROUP_MEMBER_STATUS.HEALTHY;
}

// 解析 active_group_ids 字段(JSON 字符串)→ 规范化数组 [{ id, status }]:
// - 旧格式(纯字符串数组 ["-1001", ...])→ 元素转 { id, status: '健康' }(历史数据无状态,默认健康);
// - 新格式({ id, status })→ 校验 status,非法值回退健康;
// - 非法 JSON / 非数组 / 元素结构异常 → 返回空数组(上层重建,不抛错)。
function parseActiveGroups(rawStr) {
	if (!rawStr) return [];
	let parsed;
	try {
		parsed = JSON.parse(rawStr);
	} catch (error) {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const groups = [];
	for (const item of parsed) {
		if (typeof item === 'string') {
			const id = item.trim();
			if (id === '') continue;
			groups.push({ id, status: GROUP_MEMBER_STATUS.HEALTHY });
		} else if (item && typeof item === 'object' && (typeof item.id === 'string' || typeof item.id === 'number')) {
			const id = String(item.id);
			if (id === '') continue;
			groups.push({ id, status: normalizeGroupStatus(item.status) });
		}
	}
	return groups;
}

// Telegram getChatMember.status → 群内状态映射:
// - kicked(被踢出/封禁)→ 封禁;
// - restricted 且 can_send_messages === false(被禁言)→ 禁言;
// - administrator / creator(群主/管理员)→ 管理员;
// - 其余(member/left/restricted 可发言/未知)→ 健康。
// can_send_messages 为 getChatMember 返回的直挂属性;kicked/left 等状态该字段为 undefined,不误判。
function mapTgStatusToGroupStatus(status, canSendMessages) {
	if (status === 'kicked') return GROUP_MEMBER_STATUS.BANNED;
	if (status === 'restricted' && canSendMessages === false) return GROUP_MEMBER_STATUS.MUTED;
	if (status === 'administrator' || status === 'creator') return GROUP_MEMBER_STATUS.ADMIN;
	return GROUP_MEMBER_STATUS.HEALTHY;
}

// 标记用户在某群组的状态(写入 active_group_ids 数组元素的 status):
// - 用户不存在时自动建档(仅写 tgid + active_group_ids + created_at,不触碰其他列);
// - 非法状态值回退"健康";读不到数组(非法 JSON 等)时按空数组重建;
// - 成功返回 true,失败返回 false(不抛错,不阻塞上层业务)。
async function dbSetUserGroupStatus(env, tgid, chatId, status) {
	if (!hasDb(env)) return false;
	const tgidStr = String(tgid);
	const chatIdStr = String(chatId);
	const normalizedStatus = normalizeGroupStatus(status);
	const now = Math.floor(Date.now() / 1000);
	try {
		let groups = [];
		try {
			const row = await env.DB.prepare('SELECT active_group_ids FROM users WHERE tgid = ?').bind(tgidStr).first();
			if (row?.active_group_ids) {
				groups = parseActiveGroups(row.active_group_ids);
			}
		} catch (readErr) {
			console.error('[DB] 读取活跃群组失败:', readErr.message);
		}
		const existing = groups.find((g) => g.id === chatIdStr);
		if (existing) {
			existing.status = normalizedStatus;
		} else {
			groups.push({ id: chatIdStr, status: normalizedStatus });
		}
		await env.DB.prepare(
			`INSERT INTO users (tgid, active_group_ids, created_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(tgid) DO UPDATE SET active_group_ids = excluded.active_group_ids`
		).bind(tgidStr, JSON.stringify(groups), now).run();
		return true;
	} catch (error) {
		console.error('[DB] 标记群组状态失败:', error.message);
		return false;
	}
}

// 读取用户在某群组的状态;用户不存在或未记录该群 → 返回 null(上层区分"未记录"与"健康")。
async function dbGetUserGroupStatus(env, tgid, chatId) {
	if (!hasDb(env)) return null;
	try {
		const row = await env.DB.prepare('SELECT active_group_ids FROM users WHERE tgid = ?').bind(String(tgid)).first();
		if (!row?.active_group_ids) return null;
		const groups = parseActiveGroups(row.active_group_ids);
		const found = groups.find((g) => g.id === String(chatId));
		return found ? found.status : null;
	} catch (error) {
		console.error('[DB] 读取群组状态失败:', error.message);
		return null;
	}
}

// 联网黑名单查杀:一次查询取黑名单标记 + 活跃群组原始 JSON(用户不存在返回 null)。
// 业务层(handleNetworkBlacklistKill)与 QA 测试共用,避免两次读库。
async function dbGetUserKillInfo(env, tgid) {
	if (!hasDb(env)) return null;
	try {
		const row = await env.DB.prepare('SELECT is_blacklisted, active_group_ids FROM users WHERE tgid = ?').bind(String(tgid)).first();
		if (!row) return null;
		return {
			isBlacklisted: Boolean(row.is_blacklisted),
			active_group_ids: row.active_group_ids
		};
	} catch (error) {
		console.error('[DB] 读取查杀信息失败:', error.message);
		return null;
	}
}

// 联网查杀决策(纯逻辑、无 IO,可单测):根据用户行数据判断在当前群应执行的动作。
// 语义(与需求一致):
// - 用户不存在 → { action: 'record' } 建档放行(新用户不可能在 CM 黑名单);
// - 本群已有状态且非"健康"(禁言/封禁/白名单/管理员)→ { action: 'skip', status } 已处理或豁免,不重复查杀;
// - 本群无状态记录 → 视同"健康"(存量用户首次出现在本群),继续黑名单判定;
// - 状态"健康"但不在黑名单 → { action: 'skip', reason: 'not-blacklisted' };
// - 状态"健康"且 is_blacklisted=1 → { action: 'mute' } 命中 CM 黑名单,禁言 + 通知。
function decideNetKillAction(row, chatId) {
	if (!row) return { action: 'record' };
	const status = parseActiveGroups(row.active_group_ids)
		.find((g) => g.id === String(chatId))?.status || GROUP_MEMBER_STATUS.HEALTHY;
	if (status !== GROUP_MEMBER_STATUS.HEALTHY) return { action: 'skip', status };
	if (!row.isBlacklisted) return { action: 'skip', reason: 'not-blacklisted' };
	return { action: 'mute' };
}

// 实例级 DB 初始化标记:首次请求完成建表+迁移后置 true,避免每请求重复检查
let dbReady = false;
// 用户黑名单实例级内存缓存:短 TTL 降低 D1 读频率(tgid → { isBlacklisted, banReason, bannedAt, fetchedAt })
const DB_USER_CACHE_TTL_MS = 5000;
let dbUserCache = new Map();

function hasDb(env) {
	return Boolean(env?.DB);
}

// 失效用户缓存:传 tgid 只清单个,不传清全部(封禁/解封/白名单变更后调用)
function invalidateDbUserCache(tgid) {
	if (tgid === undefined || tgid === null) {
		dbUserCache.clear();
	} else {
		dbUserCache.delete(String(tgid));
	}
}

// 时间戳(epoch 秒)→ 北京时间字符串;0/缺失 → "未知"
function formatTimestamp(ts) {
	if (!ts || ts <= 0) return '未知';
	const d = new Date(ts * 1000 + 8 * 3600 * 1000);
	const pad = (n) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// 幂等建表 + 旧库列级升级(SQLite ALTER TABLE ADD COLUMN 补齐缺失列):
// 新库直接按 DB_SCHEMA_SQL 全量建表;已上线的旧库 CREATE TABLE IF NOT EXISTS 不会补列,
// 这里用 PRAGMA table_info 检查缺失列并逐个补齐,保证旧数据不丢、新字段有默认值。
//
// ⚠️ D1 与真 SQLite 的差异(必须忽略此坑的请打住):
//   - 真 SQLite 的 `connection.exec(sql)` / `db.exec(sql)` 接受任意换行/多语句,一次可吃多条以 `;` 分隔的 SQL;
//   - D1 Workers 绑定的 `env.DB.exec(sql)` 按 `\n` 分隔多条查询,每条查询必须在一行内完成
//     (官方文档原话:"The input can be one or multiple queries separated by `\n`.")。
//     多行排版 SQL(如建表语句)首行未写完就会报 `incomplete input`;QA 在 node:sqlite 测试里
//     能跑过(那是真 SQLite 的 exec 语义)不代表生产环境 OK。
//   - DB.batch 只能装 DML(prepared statement),不能装 DDL。所以多张表只能用循环 exec。
//   - 此处把 DB_SCHEMA_SQL 按 `;` 拆开,每条语句压成单行并以 `;` 结尾,再逐条 exec
//     (模板字符串保持可读排版,运行时由 flattenSqlStatements 压平),保证传给 D1 的每条 SQL
//     都是一行完整语句。
// 把多行 SQL 模板压成"单行完整语句"列表:按 `;` 拆分,折叠换行/缩进/多余空白为单个空格,
// 跳过空段并补回结尾分号(D1 exec 需要)。只折叠空白,不改动单引号字符串字面量(DEFAULT '[]' 等)。
function flattenSqlStatements(multiSql) {
	return multiSql
		.split(';')
		.map((stmt) => stmt.replace(/\s+/g, ' ').trim())
		.filter((stmt) => stmt.length > 0)
		.map((stmt) => stmt + ';');
}
async function ensureDbSchema(env) {
	for (const sql of flattenSqlStatements(DB_SCHEMA_SQL)) {
		await env.DB.exec(sql);
	}
	const colsRes = await env.DB.prepare('PRAGMA table_info(users)').all();
	const cols = (colsRes.results || []).map((c) => c.name);
	const upgradeCols = [
		['is_gky_blacklisted', 'INTEGER NOT NULL DEFAULT 0'],
		['banned_by', "TEXT NOT NULL DEFAULT ''"],
		['unbanned_by', "TEXT NOT NULL DEFAULT ''"]
	];
	for (const [name, def] of upgradeCols) {
		if (!cols.includes(name)) {
			await env.DB.exec(`ALTER TABLE users ADD COLUMN ${name} ${def};`);
			console.log(`[DB] 升级 users 表: 新增列 ${name}`);
		}
	}
	return true;
}

// 惰性初始化:建表/升级 + 检查 KV 迁移状态,未完成则执行迁移。
// 返回是否已就绪;无 D1 绑定返回 false(上层走 KV 回退)。
async function ensureDbReady(env) {
	if (dbReady) return true;
	if (!hasDb(env)) return false;
	try {
		await ensureDbSchema(env);
		const row = await env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(DB_KV_IMPORT_KEY).first();
		if (row?.value === 'done') {
			dbReady = true;
			return true;
		}
		const result = await migrateFromKV(env);
		if (result.migrated) dbReady = true;
		return result.migrated;
	} catch (error) {
		console.error('[DB] 初始化失败:', error.message);
		return false;
	}
}

// DB 是否已确认就绪:绑定 D1 且本实例完成建表+迁移。
// 未就绪时上层读写回退 KV,避免迁移窗口期打空表漏放黑名单。
function isDbReady(env) {
	return dbReady && hasDb(env);
}

// KV → D1 一次性数据迁移(幂等):
// - 抢锁:INSERT OR IGNORE 写入 kv_imported_v1='started:<时间戳>',changes=1 的实例负责导入;
// - 导入:KV blacklist → is_blacklisted=1(缺失时间填默认 0),KV ad_admin_list → can_report=1;
// - 完成:标记 'done';失败回滚锁,下次请求重试。
// - 锁租约:锁携带时间戳,持锁实例崩溃后锁超龄(>120s)由其他实例清除并重新抢锁,防止迁移永久停滞。
async function migrateFromKV(env) {
	if (!hasDb(env)) return { migrated: false, error: 'no-db' };
	try {
		// 幂等建表 + 旧库列升级(即使 ensureDbReady 已执行过,双保险)
		await ensureDbSchema(env);

		const lockTs = Math.floor(Date.now() / 1000);
		const lockRes = await env.DB.prepare(
			'INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)'
		).bind(DB_KV_IMPORT_KEY, 'started:' + lockTs).run();
		const isMigrator = lockRes.meta?.changes === 1;

		if (!isMigrator) {
			// 其他实例正在迁移/已完成:轮询等待迁移者写 'done'(每次 100ms,最多 DB_MIGRATE_WAIT_MS)
			const waitedUntil = Date.now() + DB_MIGRATE_WAIT_MS;
			while (Date.now() < waitedUntil) {
				const row = await env.DB.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(DB_KV_IMPORT_KEY).first();
				if (row?.value === 'done') return { migrated: true, imported: true };
				if (row?.value && String(row.value).startsWith('started:')) {
					const startedTs = Number(String(row.value).slice('started:'.length));
					if (Number.isFinite(startedTs) && Date.now() / 1000 - startedTs > DB_MIGRATE_LOCK_TTL_SECONDS) {
						// 陈旧锁:持锁实例崩溃/被回收,清除后重新抢锁(递归一次)
						await env.DB.prepare('DELETE FROM schema_meta WHERE key = ?').bind(DB_KV_IMPORT_KEY).run();
						return await migrateFromKV(env);
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			// 等待超时(迁移者仍在进行或锁未超龄):返回未就绪,
			// ensureDbReady 不会置 dbReady,本请求读写回退 KV,下次请求继续尝试
			return { migrated: false, error: 'migration-wait-timeout' };
		}

		// 读 KV 旧数据;KV 未绑定则视为无旧数据直接跳过。
		// 区分两类错误:KV 基础设施故障(网络/配额)→ 抛错回滚锁,下次请求重试;
		//               脏数据(值不是合法 JSON / 非数组)→ 跳过并警告,不中断迁移(否则坏数据会永久阻塞迁移)。
		let blacklist = [];
		if (env.KV) {
			try {
				const rawStr = await env.KV.get('blacklist');
				if (rawStr !== null) {
					try {
						const parsed = JSON.parse(rawStr);
						if (Array.isArray(parsed)) blacklist = parsed;
						else console.error('[DB] KV blacklist 非数组,跳过(需人工检查 KV): typeof=' + typeof parsed);
					} catch (jsonErr) {
						console.error('[DB] KV blacklist 不是合法 JSON,跳过(需人工检查 KV):', jsonErr.message);
					}
				}
			} catch (error) {
				throw new Error('读取 KV blacklist 失败: ' + error.message);
			}
		}
		let adAdminList = [];
		if (env.KV) {
			try {
				const rawStr = await env.KV.get('ad_admin_list');
				if (rawStr !== null) {
					try {
						const parsed = JSON.parse(rawStr);
						if (Array.isArray(parsed)) adAdminList = parsed;
						else console.error('[DB] KV ad_admin_list 非数组,跳过(需人工检查 KV): typeof=' + typeof parsed);
					} catch (jsonErr) {
						console.error('[DB] KV ad_admin_list 不是合法 JSON,跳过(需人工检查 KV):', jsonErr.message);
					}
				}
			} catch (error) {
				throw new Error('读取 KV ad_admin_list 失败: ' + error.message);
			}
		}

		const now = Math.floor(Date.now() / 1000);
		// 过滤无效元素:仅保留 number/string 标量,对象/数组/布尔/null 等一律跳过
		// (否则对象会被 String() 化成 '[object Object]' 作为 tgid 入库产生脏行)
		const isScalarTgid = (t) => (typeof t === 'number' || typeof t === 'string') && String(t) !== '';
		const validBlacklist = blacklist.filter(isScalarTgid);
		const validAdAdminList = adAdminList.filter(isScalarTgid);
		const stmts = [];
		for (const tgid of validBlacklist) {
			stmts.push(env.DB.prepare(
				`INSERT INTO users (tgid, is_blacklisted, ban_reason, banned_at, created_at)
				 VALUES (?, 1, ?, ?, ?)
				 ON CONFLICT(tgid) DO UPDATE SET
				   is_blacklisted = 1,
				   ban_reason = excluded.ban_reason,
				   banned_at = excluded.banned_at`
			).bind(String(tgid), DB_BAN_REASON_MAP.ban, DB_DEFAULT_UNKNOWN_TIME, now));
		}
		for (const tgid of validAdAdminList) {
			stmts.push(env.DB.prepare(
				`INSERT INTO users (tgid, can_report, created_at)
				 VALUES (?, 1, ?)
				 ON CONFLICT(tgid) DO UPDATE SET can_report = 1`
			).bind(String(tgid), now));
		}
		if (stmts.length > 0) {
			// 分批写入,避免单请求 batch 过大超限
			for (let i = 0; i < stmts.length; i += 100) {
				await env.DB.batch(stmts.slice(i, i + 100));
			}
		}

		await env.DB.prepare("UPDATE schema_meta SET value = 'done' WHERE key = ?").bind(DB_KV_IMPORT_KEY).run();
		console.log(`[DB] KV → D1 迁移完成: blacklist=${validBlacklist.length}, ad_admin_list=${validAdAdminList.length}`);
		return { migrated: true, importedBlacklist: validBlacklist.length, importedAdAdmins: validAdAdminList.length };
	} catch (error) {
		// 回滚锁,允许下次重试(已插入部分通过 ON CONFLICT 幂等,重复执行安全)
		try {
			await env.DB.prepare('DELETE FROM schema_meta WHERE key = ?').bind(DB_KV_IMPORT_KEY).run();
		} catch (_) { }
		console.error('[DB] KV → D1 迁移失败:', error.message);
		return { migrated: false, error: error.message };
	}
}

// 记录用户活动:tgid 唯一标识,每次收到消息时更新资料快照 / 最后对话时间 / 活跃群组 / 消息计数。
// 群聊(chat.type 为 group/supergroup)才把 chat.id 并入活跃群组数组;私聊只更新档案与时间。
async function recordUserActivity(message, env) {
	if (!isDbReady(env)) return;
	const from = message?.from;
	if (!from || from.id === undefined || from.id === null) return;
	const chat = message?.chat;
	const tgid = String(from.id);
	const now = Math.floor(Date.now() / 1000);
	const isGroupChat = chat?.type === 'group' || chat?.type === 'supergroup';

	if (isGroupChat && chat?.id !== undefined && chat.id !== null) {
		// 群聊:先读活跃群组数组(元素 {id, status}),合并当前群后写回。
		// 收到消息说明该用户当前在本群可发言 → 刷新本群状态为"健康"
		// (曾被禁言/封禁的用户若恢复发言,再次发言时状态自动回正)。
		// 已知竞态:同一用户并发在多个群发言时,读-改-写可能丢失一个群 ID
		// (概率极低:单用户消息经 Webhook 串行到达,且群数量有限;如需严格可改规范化子表)。
		const chatIdStr = String(chat.id);
		let groupIds = [];
		try {
			const row = await env.DB.prepare('SELECT active_group_ids FROM users WHERE tgid = ?').bind(tgid).first();
			if (row?.active_group_ids) {
				groupIds = parseActiveGroups(row.active_group_ids); // 兼容旧格式与非法 JSON,不抛错
			}
		} catch (error) {
			console.error('[DB] 读取活跃群组失败:', error.message);
		}
		const existingGroup = groupIds.find((g) => g.id === chatIdStr);
		// 管理员在群内发言 → 标记"管理员";普通成员 → "健康"
		// (管理员豁免:即使 DB 中残留禁言/封禁标记,发言时也回正为"管理员")
		const isAdmin = await isGroupAdmin(tgid);
		// 白名单豁免保持:被管理员显式加入本群白名单的用户,其"白名单"状态不因发言回正为"健康",
		// 否则下一条消息会被"联网黑名单自动查杀"再次禁言(白名单 = 本群免查杀豁免)。
		const refreshedStatus = existingGroup?.status === GROUP_MEMBER_STATUS.WHITELISTED
			? GROUP_MEMBER_STATUS.WHITELISTED
			: (isAdmin ? GROUP_MEMBER_STATUS.ADMIN : GROUP_MEMBER_STATUS.HEALTHY);
		// 管理员发言 → 顺手修复黑名单数据层(历史遗留的 is_blacklisted=1 管理员行清为 0)
		if (isAdmin) {
			await dbClearBlacklistStatus(env, tgid);
		}
		if (existingGroup) {
			existingGroup.status = refreshedStatus;
		} else {
			groupIds.push({ id: chatIdStr, status: refreshedStatus });
		}

		try {
			await env.DB.prepare(
				`INSERT INTO users (tgid, first_name, last_name, username, is_bot, last_active_at, active_group_ids, created_at, message_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
				 ON CONFLICT(tgid) DO UPDATE SET
				   first_name = excluded.first_name,
				   last_name = excluded.last_name,
				   username = excluded.username,
				   is_bot = excluded.is_bot,
				   last_active_at = excluded.last_active_at,
				   active_group_ids = excluded.active_group_ids,
				   message_count = message_count + 1`
			).bind(tgid, from.first_name || '', from.last_name || '', from.username || '', from.is_bot ? 1 : 0, now, JSON.stringify(groupIds), now).run();
		} catch (error) {
			console.error('[DB] 记录用户活动失败(群聊):', error.message);
		}
	} else {
		// 私聊/其他:仅更新档案与时间,不触碰 active_group_ids(避免覆盖既有群记录)
		try {
			await env.DB.prepare(
				`INSERT INTO users (tgid, first_name, last_name, username, is_bot, last_active_at, created_at, message_count)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 1)
				 ON CONFLICT(tgid) DO UPDATE SET
				   first_name = excluded.first_name,
				   last_name = excluded.last_name,
				   username = excluded.username,
				   is_bot = excluded.is_bot,
				   last_active_at = excluded.last_active_at,
				   message_count = message_count + 1`
			).bind(tgid, from.first_name || '', from.last_name || '', from.username || '', from.is_bot ? 1 : 0, now, now).run();
		} catch (error) {
			console.error('[DB] 记录用户活动失败(私聊):', error.message);
		}
	}
}

// 管理员黑名单数据修复:将 is_blacklisted 清 0(保留 ban_reason/banned_at/banned_by 作审计痕迹)。
// 识别到 GROUP_ID 群管理员时调用,保证数据层与查询层一致(管理员 is_blacklisted 恒为 0,
// D1 控制台/任何直接读库的路径看到的都是 0,而非仅查询层豁免)。
// 与 /unban 不同:不写 last_unban_at/unbanned_by(这是系统自动豁免,不是管理员的解封动作)。
// 返回 true 表示实际清除了脏数据,false 表示无需处理(本就为 0 或用户不存在或失败)。
async function dbClearBlacklistStatus(env, tgid) {
	if (!hasDb(env)) return false;
	try {
		const info = await env.DB.prepare(
			'UPDATE users SET is_blacklisted = 0 WHERE tgid = ? AND is_blacklisted = 1'
		).bind(String(tgid)).run();
		const cleared = Boolean(info?.meta?.changes);
		if (cleared) {
			console.log(`[DB] 管理员黑名单数据修复: tgid=${tgid} is_blacklisted 已清为 0`);
			invalidateDbUserCache(String(tgid));
		}
		return cleared;
	} catch (error) {
		console.error('[DB] 管理员黑名单数据修复失败:', error.message);
		return false;
	}
}

// D1 版黑名单查询(带 5s 实例级缓存);无 D1 绑定直接返回未命中(上层 hasDb 已分流,此处为防御)
// 管理员豁免:即使 DB 中 is_blacklisted=1,GROUP_ID 群管理员也永远视为未拉黑(查询结果恒为 0)。
// 豁免在写入层(dbAddToBlacklist)已拒绝管理员入库,这里兜底历史数据/绕过写入层的存量脏数据,
// 并在命中时顺手把数据层 is_blacklisted 清 0(一次查询即修复,下次控制台刷新即见 0)。
async function dbCheckBlacklist(env, userId) {
	if (!hasDb(env)) return { isBlacklisted: false, message: null };
	const tgid = String(userId);
	const now = Date.now();
	const cached = dbUserCache.get(tgid);
	if (cached && (now - cached.fetchedAt) < DB_USER_CACHE_TTL_MS) {
		return cached.isBlacklisted
			? { isBlacklisted: true, message: '❌ 您的TGID在黑名单中，请自行联系管理员解封。', banReason: cached.banReason, bannedAt: cached.bannedAt }
			: { isBlacklisted: false, message: null };
	}
	try {
		const row = await env.DB.prepare('SELECT is_blacklisted, ban_reason, banned_at FROM users WHERE tgid = ?').bind(tgid).first();
		let isBlacklisted = Boolean(row?.is_blacklisted);
		const banReason = row?.ban_reason || '';
		const bannedAt = row?.banned_at || 0;
		// 命中黑名单 → 复核是否为 GROUP_ID 群管理员,是则视为未拉黑并修复数据层(管理员 is_blacklisted 永远为 0)
		if (isBlacklisted && await isGroupAdmin(tgid)) {
			console.log(`[DB] 黑名单豁免: tgid=${tgid} 是群组管理员,视为未拉黑`);
			isBlacklisted = false;
			await dbClearBlacklistStatus(env, tgid);
		}
		dbUserCache.set(tgid, { isBlacklisted, banReason, bannedAt, fetchedAt: now });
		return isBlacklisted
			? { isBlacklisted: true, message: '❌ 您的TGID在黑名单中，请自行联系管理员解封。', banReason, bannedAt }
			: { isBlacklisted: false, message: null };
	} catch (error) {
		console.error('检查黑名单时出错:', error);
		return { isBlacklisted: false, message: null };
	}
}

// D1 版添加黑名单:source ∈ ad/spam/ban,映射 ban_reason 并记录封禁时间与处理人 tgid
// operatorId: 处理人 tgid(溯源)——/ad 传举报发起人, /spam、/ban 传操作管理员
// 管理员豁免:GROUP_ID 群管理员(含群主)一律拒绝加入黑名单(写入层保证 is_blacklisted 恒为 0)
async function dbAddToBlacklist(env, userId, source, operatorId) {
	if (!hasDb(env)) return { success: false, message: '❌ 未绑定D1数据库' };
	const tgid = String(userId);
	const operator = operatorId === undefined || operatorId === null ? '' : String(operatorId);
	const now = Math.floor(Date.now() / 1000);
	const banReason = DB_BAN_REASON_MAP[source] || DB_BAN_REASON_MAP.ban;
	try {
		// 管理员豁免优先:先确认身份再判断是否已存在(管理员永远不允许入黑名单)
		if (await isGroupAdmin(tgid)) {
			console.log(`[DB] 黑名单写入拒绝: tgid=${tgid} 是群组管理员,不允许加入黑名单`);
			// 顺手修复存量脏数据(历史遗留的 is_blacklisted=1 管理员行)
			await dbClearBlacklistStatus(env, tgid);
			return { success: false, adminExempt: true, message: '⚠️ 该用户是群组管理员，不能加入黑名单' };
		}
		const existing = await env.DB.prepare('SELECT is_blacklisted FROM users WHERE tgid = ?').bind(tgid).first();
		if (existing?.is_blacklisted) {
			return { success: false, alreadyExists: true, message: '⚠️ 该用户已在黑名单中' };
		}
		await env.DB.prepare(
			`INSERT INTO users (tgid, is_blacklisted, ban_reason, banned_at, banned_by, created_at)
			 VALUES (?, 1, ?, ?, ?, ?)
			 ON CONFLICT(tgid) DO UPDATE SET
			   is_blacklisted = 1,
			   ban_reason = excluded.ban_reason,
			   banned_at = excluded.banned_at,
			   banned_by = excluded.banned_by`
		).bind(tgid, banReason, now, operator, now).run();
		invalidateDbUserCache(tgid);
		return { success: true, message: `✅ 已将用户 <code>${userId}</code> 添加到黑名单` };
	} catch (error) {
		console.error('添加黑名单时出错:', error);
		return { success: false, message: '❌ 添加黑名单失败: ' + error.message };
	}
}

// D1 版移除黑名单:清除标记/原因/时间,记录解封时间与处理人 tgid(溯源)
// operatorId: 处理人 tgid——/unban 传操作管理员;自助解封传用户本人
async function dbRemoveFromBlacklist(env, userId, operatorId) {
	if (!hasDb(env)) return { success: false, message: '❌ 未绑定D1数据库' };
	const tgid = String(userId);
	const operator = operatorId === undefined || operatorId === null ? '' : String(operatorId);
	try {
		const row = await env.DB.prepare('SELECT is_blacklisted FROM users WHERE tgid = ?').bind(tgid).first();
		if (!row?.is_blacklisted) {
			return { success: false, notFound: true, message: '⚠️ 该用户不在黑名单中' };
		}
		await env.DB.prepare(
			'UPDATE users SET is_blacklisted = 0, ban_reason = ?, banned_at = ?, last_unban_at = ?, unbanned_by = ? WHERE tgid = ?'
		).bind('', DB_DEFAULT_UNKNOWN_TIME, Math.floor(Date.now() / 1000), operator, tgid).run();
		invalidateDbUserCache(tgid);
		return { success: true, message: `✅ 已将用户 <code>${userId}</code> 从黑名单中移除` };
	} catch (error) {
		console.error('移除黑名单时出错:', error);
		return { success: false, message: '❌ 移除黑名单失败: ' + error.message };
	}
}

// D1 版同步 GKY 黑名单状态(/check 查到 GKY 封禁记录时调用,后期可直接按此字段筛选)
async function dbSetGkyBlacklistStatus(env, userId, isGkyBanned) {
	if (!hasDb(env)) return;
	try {
		await env.DB.prepare(
			`INSERT INTO users (tgid, is_gky_blacklisted, created_at)
			 VALUES (?, ?, ?)
			 ON CONFLICT(tgid) DO UPDATE SET is_gky_blacklisted = excluded.is_gky_blacklisted`
		).bind(String(userId), isGkyBanned ? 1 : 0, Math.floor(Date.now() / 1000)).run();
	} catch (error) {
		console.error('[DB] 更新 GKY 黑名单状态失败:', error.message);
	}
}

// D1 版读取 /add_ad_admin 白名单(tgid 数组,兼容旧调用方)
async function dbGetAdAdminList(env) {
	if (!hasDb(env)) return [];
	try {
		const res = await env.DB.prepare('SELECT tgid FROM users WHERE can_report = 1').all();
		return (res.results || []).map((r) => r.tgid);
	} catch (error) {
		console.error('[/ad] 读取 ad_admin_list 失败:', error.message);
		return [];
	}
}

// D1 版整体保存 /add_ad_admin 白名单:先全量清零,再逐个置位(list 为权威)
async function dbSaveAdAdminList(env, list) {
	if (!hasDb(env)) return false;
	try {
		const now = Math.floor(Date.now() / 1000);
		const stmts = [env.DB.prepare('UPDATE users SET can_report = 0 WHERE can_report = 1')];
		for (const tgid of list) {
			if (tgid === undefined || tgid === null || String(tgid) === '') continue;
			stmts.push(env.DB.prepare(
				`INSERT INTO users (tgid, can_report, created_at)
				 VALUES (?, 1, ?)
				 ON CONFLICT(tgid) DO UPDATE SET can_report = 1`
			).bind(String(tgid), now));
		}
		await env.DB.batch(stmts);
		invalidateDbUserCache();
		return true;
	} catch (error) {
		console.error('[/ad] 保存 ad_admin_list 失败:', error.message);
		return false;
	}
}

// D1 版举报资格判断(/add_ad_admin 白名单)
async function dbIsAdAllowlisted(env, userId) {
	if (!hasDb(env)) return false;
	try {
		const row = await env.DB.prepare('SELECT can_report FROM users WHERE tgid = ?').bind(String(userId)).first();
		return Boolean(row?.can_report);
	} catch (error) {
		console.error('[/ad] 判断举报资格失败:', error.message);
		return false;
	}
}
// [DB-LAYER-END]

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		AD_VOTE_THRESHOLD = parseInt(env.AD_VOTE_THRESHOLD) || AD_VOTE_THRESHOLD;
		AD_GROUP_RULES = String(env.AD_GROUP_RULES || '').trim() || AD_GROUP_RULES;
		AD_AI_MODEL = String(env.AD_AI_MODEL || '').trim() || AD_AI_MODEL;
		AD_AI_TIMEOUT_MS = parseInt(env.AD_AI_TIMEOUT_MS) || AD_AI_TIMEOUT_MS;
		const path = url.pathname.slice(1); // 移除开头的斜杠
		let TOKEN;

		try {
			const config = loadRequiredConfig(env);
			TOKEN = config.TOKEN;
			BOT_TOKEN = config.BOT_TOKEN;
			GROUP_ID = config.GROUP_ID;
		} catch (error) {
			return jsonResponse({
				success: false,
				error: error.message
			}, 500);
		}

		// 数据库模式:首个请求惰性建表 + 执行 KV→D1 自动迁移(幂等;无 D1 绑定跳过,自动回退 KV)
		await ensureDbReady(env);

		if (url.pathname === "/banlist" && url.searchParams.has('tgid') && url.searchParams.get('tgid') != '') {
			const tgid = url.searchParams.get('tgid');
			const banlist = await handleBanlist(tgid);
			return new Response(banlist, {
				headers: { 'Content-Type': 'application/json; charset=UTF-8' }
			});;
		} else if (request.method === 'POST') {
			// 如果是 Telegram Webhook 请求
			if (path === '') {
				const update = await request.json();
				console.log('[Telegram更新] 收到更新:', JSON.stringify({
					更新ID: update.update_id,
					包含字段: Object.keys(update),
					有普通消息: Boolean(update.message),
					是否新成员入群消息: Array.isArray(update.message?.new_chat_members),
					新成员数量: update.message?.new_chat_members?.length || 0,
					有编辑消息: Boolean(update.edited_message),
					有频道消息: Boolean(update.channel_post),
					有消息反应: Boolean(update.message_reaction)
				}));

				// 处理消息
				if (update.message) {
					// 数据库版:对所有收到消息的 tgid 记录活动(资料快照/最后对话时间/活跃群组/消息计数)
					await recordUserActivity(update.message, env);
					await handleMessage(update.message, env);
				} else if (update.callback_query) {
					// 优先处理联网查杀按钮回调(cmk: 前缀),未被消费再交给 /ad 投票回调
					const consumed = await handleNetworkKillCallbackQuery(update.callback_query, env);
					if (!consumed) {
						await handleAdCallbackQuery(update.callback_query, env);
					}
				} else {
					console.log('[Telegram更新] 跳过：update.message 和 update.callback_query 都为空，当前代码只处理普通消息和投票回调。');
				}

				return new Response('OK');
			} else if (path === TOKEN) {
				// 处理初始化命令
				return await handleInitialization(request);
			}
		} else if (request.method === 'GET' && path === TOKEN) {
			// 处理 GET 初始化请求
			return await handleInitialization(request);
		}

		return new Response('Method Not Allowed', { status: 405 });
	}
};

function loadRequiredConfig(env) {
	const requiredEnvVars = ['TOKEN', 'BOT_TOKEN', 'GROUP_ID'];
	const missing = requiredEnvVars.filter((name) => {
		const value = env?.[name];
		return value === undefined || value === null || String(value).trim() === '';
	});

	if (missing.length > 0) {
		throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
	}

	return {
		TOKEN: String(env.TOKEN).trim(),
		BOT_TOKEN: String(env.BOT_TOKEN).trim(),
		GROUP_ID: String(env.GROUP_ID).trim()
	};
}

// 处理初始化命令
function jsonResponse(data, status = 200) {
	return new Response(JSON.stringify(data, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=UTF-8' }
	});
}

async function handleInitialization(request) {
	try {
		// 设置 Webhook
		const webhookUrl = new URL(request.url);
		webhookUrl.pathname = '/';

		const setWebhookUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`;
		const setWebhookBody = {
			url: webhookUrl.toString(),
			allowed_updates: ['message', 'callback_query']
		};

		const response = await fetch(setWebhookUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(setWebhookBody)
		});

		if (!response.ok) {
			const result = await response.json();
			return jsonResponse({
				成功: false,
				消息: 'Webhook 设置失败',
				Webhook: {
					目标地址: webhookUrl.toString(),
					允许更新类型: setWebhookBody.allowed_updates,
					HTTP状态码: response.status,
					Telegram返回: result
				}
			}, 500);
		}

		// 设置机器人命令
		const setCommandsUrl = `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`;
		const setCommandsBody = {
			commands: [
				{ command: "unban", description: "开始自助解封" },
				{ command: "ban", description: "添加用户到黑名单 (管理员)" },
				{ command: "spam", description: "回复消息添加用户到黑名单 (管理员)" },
				{ command: "check", description: "查询用户封禁状态 (管理员)" }
			]
		};

		const commandsResponse = await fetch(setCommandsUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(setCommandsBody)
		});

		if (commandsResponse.ok) {
			return jsonResponse({
				成功: true,
				消息: 'Webhook 和命令设置成功',
				Webhook: {
					已设置: true,
					目标地址: webhookUrl.toString(),
					允许更新类型: setWebhookBody.allowed_updates
				},
				命令: {
					已设置: true
				}
			});
		} else {
			const result = await commandsResponse.json();
			return jsonResponse({
				成功: false,
				消息: '命令设置失败',
				Webhook: {
					已设置: true,
					目标地址: webhookUrl.toString(),
					允许更新类型: setWebhookBody.allowed_updates
				},
				命令: {
					已设置: false,
					HTTP状态码: commandsResponse.status,
					Telegram返回: result
				}
			}, 500);
		}
	} catch (error) {
		return jsonResponse({
			成功: false,
			消息: '内部服务器错误',
			错误: error.message
		}, 500);
	}
}

// 黑名单写入后调用,立即失效本实例缓存,保证封禁/解封即时生效
function invalidateBlacklistCache() {
	blacklistCache = { data: null, fetchedAt: 0 };
}

// 检查用户是否在黑名单中
async function checkBlacklist(userId, env) {
	// D1 优先:绑定数据库后走 DB 层(含 5s 实例级缓存);未绑定则回退 KV
	if (isDbReady(env)) {
		return await dbCheckBlacklist(env, userId);
	}

	// 检查是否绑定了 KV 空间
	if (!env.KV) {
		return { isBlacklisted: false, message: null };
	}

	const now = Date.now();
	// 实例级内存缓存命中:TTL 内直接复用,不读 KV
	const cacheValid = blacklistCache.data !== null && (now - blacklistCache.fetchedAt) < BLACKLIST_CACHE_TTL_MS;
	if (cacheValid) {
		if (blacklistCache.data.includes(userId.toString()) || blacklistCache.data.includes(userId)) {
			return {
				isBlacklisted: true,
				message: '❌ 您的TGID在黑名单中，请自行联系管理员解封。'
			};
		}
		return { isBlacklisted: false, message: null };
	}

	try {
		// 读取黑名单
		let blacklist = await env.KV.get('blacklist', { type: 'json' });

		// 如果黑名单不存在，初始化为空数组
		if (!blacklist || !Array.isArray(blacklist)) {
			blacklist = [];
			await env.KV.put('blacklist', JSON.stringify(blacklist));
		}

		// 读取成功,更新实例级缓存(fetchedAt=now,后续 TTL 内直接命中)
		blacklistCache = { data: blacklist, fetchedAt: now };

		// 检查用户 ID 是否在黑名单中
		if (blacklist.includes(userId.toString()) || blacklist.includes(userId)) {
			return {
				isBlacklisted: true,
				message: '❌ 您的TGID在黑名单中，请自行联系管理员解封。'
			};
		}

		return { isBlacklisted: false, message: null };
	} catch (error) {
		console.error('检查黑名单时出错:', error);
		// 如果出错，不阻止用户操作(缓存保持不变,不写入坏数据;旧缓存若仍在 TTL 内可继续降级使用)
		return { isBlacklisted: false, message: null };
	}
}

// 添加用户到黑名单
// source: 封禁来源,用于记录黑名单原因 → 'ad'=举报投票通过 / 'spam'=管理员 /spam / 'ban'=管理员 /ban
// operatorId: 处理人 tgid(溯源),/ad 传举报发起人,/spam、/ban 传操作管理员
async function addToBlacklist(userId, env, source = 'ban', operatorId) {
	// D1 优先:绑定数据库后走 DB 层;未绑定则回退 KV
	if (isDbReady(env)) {
		return await dbAddToBlacklist(env, userId, source, operatorId);
	}

	if (!env.KV) {
		return { success: false, message: '❌ 未绑定KV存储空间' };
	}

	try {
		// 读取黑名单
		let blacklist = await env.KV.get('blacklist', { type: 'json' });

		// 如果黑名单不存在，初始化为空数组
		if (!blacklist || !Array.isArray(blacklist)) {
			blacklist = [];
		}

		const userIdStr = userId.toString();

		// 检查是否已在黑名单中
		if (blacklist.includes(userIdStr) || blacklist.includes(userId)) {
			return { success: false, alreadyExists: true, message: '⚠️ 该用户已在黑名单中' };
		}

		// 添加到黑名单
		blacklist.push(userIdStr);
		await env.KV.put('blacklist', JSON.stringify(blacklist));
		invalidateBlacklistCache(); // 黑名单已写入,立即失效实例级缓存,保证封禁即时生效

		return { success: true, message: `✅ 已将用户 <code>${userId}</code> 添加到黑名单` };
	} catch (error) {
		console.error('添加黑名单时出错:', error);
		return { success: false, message: '❌ 添加黑名单失败: ' + error.message };
	}
}

// 从黑名单中移除用户
// operatorId: 处理人 tgid(溯源),/unban 传操作管理员;自助解封传用户本人
async function removeFromBlacklist(userId, env, operatorId) {
	// D1 优先:绑定数据库后走 DB 层;未绑定则回退 KV
	if (isDbReady(env)) {
		return await dbRemoveFromBlacklist(env, userId, operatorId);
	}

	if (!env.KV) {
		return { success: false, message: '❌ 未绑定KV存储空间' };
	}

	try {
		// 读取黑名单
		let blacklist = await env.KV.get('blacklist', { type: 'json' });

		// 如果黑名单不存在，初始化为空数组
		if (!blacklist || !Array.isArray(blacklist)) {
			blacklist = [];
		}

		const userIdStr = userId.toString();
		const originalLength = blacklist.length;

		// 移除用户ID（同时处理字符串和数字类型）
		blacklist = blacklist.filter(id => id != userIdStr && id != userId);

		// 检查是否有移除
		if (blacklist.length === originalLength) {
			return { success: false, notFound: true, message: '⚠️ 该用户不在黑名单中' };
		}

		// 保存更新后的黑名单
		await env.KV.put('blacklist', JSON.stringify(blacklist));
		invalidateBlacklistCache(); // 黑名单已写入,立即失效实例级缓存,保证解封即时生效

		return { success: true, message: `✅ 已将用户 <code>${userId}</code> 从黑名单中移除` };
	} catch (error) {
		console.error('移除黑名单时出错:', error);
		return { success: false, message: '❌ 移除黑名单失败: ' + error.message };
	}
}

function isSpamCommand(text) {
	if (!text) {
		return false;
	}

	const trimmedText = text.trim();
	// 接受 /spam 和 /spam@任意机器人用户名，不限定必须 @ 当前机器人。
	return /^\/spam(?:@[^\s]+)?(?:\s|$)/i.test(trimmedText);
}

function parseCommand(text, command) {
	if (!text) {
		return null;
	}

	const trimmedText = text.trim();
	const match = trimmedText.match(new RegExp(`^\\/${command}(?:@[^\\s]+)?(?:\\s+([\\s\\S]*))?$`, 'i'));
	if (!match) {
		return null;
	}

	const args = (match[1] || '').trim();
	return {
		args,
		firstArg: args.split(/\s+/)[0] || ''
	};
}

function isManagedGroupMessage(message) {
	return message.chat.id.toString() === GROUP_ID.toString();
}

function isPrivateOrManagedGroup(message) {
	return message.chat.type === 'private' || isManagedGroupMessage(message);
}

function getCommandTargetUserId(command, message) {
	if (command.firstArg) {
		return command.firstArg;
	}

	// 群聊(含 GROUP_ID 与其他群)支持回复取目标用户;私聊无回复目标返回空
	if (!message.chat || (message.chat.type !== 'group' && message.chat.type !== 'supergroup')) {
		return '';
	}

	const repliedUserId = message.reply_to_message?.from?.id;
	return repliedUserId ? repliedUserId.toString() : '';
}

// 业务层辅助:成功执行群内操作后,同步标记该用户在 GROUP_ID 群的状态(仅 DB 模式生效)。
// 传入的 status 必须是 GROUP_MEMBER_STATUS 四态之一;标记失败仅记日志,不阻塞主流程。
async function markUserGroupStatus(env, userId, status) {
	if (!isDbReady(env)) return;
	try {
		await dbSetUserGroupStatus(env, userId, GROUP_ID, status);
	} catch (error) {
		console.error('[DB] 标记群状态失败:', error.message);
	}
}

async function getManagedGroupUser(userId) {
	try {
		const statusResult = await checkUserStatus(userId);
		return statusResult.result?.user || null;
	} catch (error) {
		console.error('获取群成员用户信息失败:', error);
		return null;
	}
}

// 恢复用户在 GROUP_ID 群的状态(unban 解封 / restrict 解除禁言)。
// env:每次成功执行恢复操作后,同步把该用户在本群状态标记为"健康"。
async function restoreUserInManagedGroup(userId, env) {
	let status = null;
	let isMember = null;
	const actions = [];
	const failures = [];

	try {
		const statusResult = await checkUserStatus(userId);
		status = statusResult.result?.status || null;
		isMember = statusResult.result?.is_member;
	} catch (error) {
		console.error('查询群内状态失败:', error);
	}

	if (status === 'kicked' || !status) {
		try {
			await unbanUser(userId);
			actions.push(`已解除群封禁`);
			await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
		} catch (error) {
			console.error('群内解除封禁失败:', error);
			failures.push(`解除封禁失败: ${escapeHtml(error.message)}`);
		}
	}

	if (status === 'restricted' && isMember !== false) {
		try {
			await restrictUser(userId);
			actions.push(`已恢复发言权限`);
			await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
		} catch (error) {
			console.error('群内恢复权限失败:', error);
			failures.push(`恢复发言权限失败: ${escapeHtml(error.message)}`);
		}
	}

	if (status === 'left') {
		actions.push(`用户当前不在群内，且未处于封禁状态`);
	}

	if (status === 'member') {
		actions.push(`用户当前未被封禁或禁言`);
	}

	if (status === 'administrator' || status === 'creator') {
		actions.push(`用户是群管理员，未调整群权限`);
	}

	if (status === 'restricted' && isMember === false) {
		try {
			await unbanUser(userId);
			actions.push(`已解除群封禁`);
			await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
		} catch (error) {
			console.error('群内解除封禁失败:', error);
			failures.push(`解除封禁失败: ${escapeHtml(error.message)}`);
		}
	}

	if (!status) {
		try {
			await restrictUser(userId);
			actions.push(`已尝试恢复发言权限`);
			await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
		} catch (error) {
			console.error('群内恢复权限失败:', error);
			failures.push(`恢复发言权限失败: ${escapeHtml(error.message)}`);
		}
	}

	if (actions.length === 0 && failures.length === 0) {
		actions.push(`已确认群权限无需调整`);
	}

	if (failures.length > 0 && actions.length === 0) {
		return {
			success: false,
			message: `⚠️ 群内解封禁失败：${failures.join('；')}`
		};
	}

	if (failures.length > 0) {
		return {
			success: false,
			message: `⚠️ ${actions.join('，')}；但${failures.join('；')}`
		};
	}

	return {
		success: true,
		message: `✅ ${actions.join('，')}：<a href="tg://user?id=${userId}">${userId}</a>`
	};
}

function escapeHtml(value) {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatUserMention(user) {
	if (!user?.id) {
		return null;
	}

	const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || user.id;
	return `<a href="tg://user?id=${user.id}">${escapeHtml(displayName)}</a>`;
}

async function buildBanlistCheckResponse(tgidToCheck, options = {}) {
	// 1. 查询 gkybot
	let banlistData = { success: false, banned: false, error: '未执行查询' };
	try {
		const banlistResult = await handleBanlist(tgidToCheck);
		banlistData = JSON.parse(banlistResult);
	} catch (error) {
		banlistData = { success: false, banned: false, error: error.message };
	}

	// 1.5 同步 GKY 黑名单状态到数据库(后期备用:可按 is_gky_blacklisted 筛选全量清单);
	//     仅查询成功且 DB 已就绪时更新,查询失败不覆盖原状态
	if (isDbReady(options.env) && banlistData.success) {
		await dbSetGkyBlacklistStatus(options.env, tgidToCheck, Boolean(banlistData.banned));
	}

	// 2. 查询本地黑名单(数据库版可返回封禁原因/时间,供下方展示)
	let isLocalBlacklisted = false;
	let localBlacklistInfo = null;
	if (options.env) {
		const blacklistCheck = await checkBlacklist(tgidToCheck, options.env);
		isLocalBlacklisted = blacklistCheck.isBlacklisted;
		if (blacklistCheck.banReason || blacklistCheck.bannedAt) {
			localBlacklistInfo = {
				banReason: blacklistCheck.banReason,
				bannedAt: blacklistCheck.bannedAt
			};
		}
	}

	const isBannedAnywhere = (banlistData.success && banlistData.banned) || isLocalBlacklisted;

	let responseMessage = '';
	if (isBannedAnywhere) {
		responseMessage += `🔍 <b>封禁查询结果</b>\n\n`;
	} else {
		responseMessage += `✅ <b>查询结果</b>\n\n`;
	}

	if (options.targetUser) {
		responseMessage += `👤 <b>用户:</b> ${formatUserMention(options.targetUser) || `<code>${escapeHtml(tgidToCheck)}</code>`}\n`;
	}
	responseMessage += `📋 <b>TGID:</b> <a href="tg://user?id=${escapeHtml(tgidToCheck)}">${escapeHtml(tgidToCheck)}</a>\n\n`;

	// GKYbot 数据库状态
	if (banlistData.success) {
		if (banlistData.banned) {
			responseMessage += `🌐 <b>GKYbot 库:</b> 🚫 <b>已封禁</b>\n`;
		} else {
			responseMessage += `🌐 <b>GKYbot 库:</b> ✅ 正常\n`;
		}
	} else {
		responseMessage += `🌐 <b>GKYbot 库:</b> ⚠️ 查询失败 (${escapeHtml(banlistData.error || '未知错误')})\n`;
	}

	// 本地黑名单状态(数据库版可附带封禁原因与时间;KV 版仅 ID 数组,无原因字段)
	if (options.env) {
		if (isLocalBlacklisted) {
			responseMessage += `💾 <b>本地黑名单:</b> 🚫 <b>已封禁</b>\n`;
			if (localBlacklistInfo?.banReason) {
				responseMessage += `     ⚠️ 原因: ${escapeHtml(localBlacklistInfo.banReason)}\n`;
			}
			if (localBlacklistInfo?.bannedAt) {
				responseMessage += `     📅 时间: ${escapeHtml(formatTimestamp(localBlacklistInfo.bannedAt))}\n`;
			}
		} else {
			responseMessage += `💾 <b>本地黑名单:</b> ✅ 正常\n`;
		}
	} else {
		responseMessage += `💾 <b>本地黑名单:</b> ⚠️ 未检查 (未配置KV/D1存储)\n`;
	}

	// 3. 输出 GKYbot 详细封禁信息
	if (banlistData.success && banlistData.banned) {
		responseMessage += `\n--- <b>GKYbot 详细封禁信息</b> ---\n`;
		if (banlistData.chatId) {
			const chatInfo = await getChatInfoFromId(banlistData.chatId);
			responseMessage += `💬 <b>ChatID:</b> <code>${escapeHtml(banlistData.chatId)}</code>`;
			if (chatInfo && chatInfo.title) {
				if (chatInfo.link) {
					responseMessage += ` (<a href="${escapeHtml(chatInfo.link)}">${escapeHtml(chatInfo.title)}</a>)`;
				} else {
					responseMessage += ` (${escapeHtml(chatInfo.title)})`;
				}
			}
			responseMessage += `\n`;
		}
		if (banlistData.msgId) responseMessage += `📨 <b>MsgID:</b> <code>${escapeHtml(banlistData.msgId)}</code>\n`;
		if (banlistData.recordedDate) responseMessage += `📅 <b>封禁日期:</b> ${escapeHtml(banlistData.recordedDate)}\n`;
		if (banlistData.reason) responseMessage += `⚠️ <b>封禁原因:</b> ${escapeHtml(banlistData.reason)}\n`;
		if (banlistData.info) responseMessage += `📝 <b>封禁内容:</b>\n<tg-spoiler>${escapeHtml(banlistData.info)}</tg-spoiler>\n`;
	}

	if (!options.includeReviewAction) {
		return { text: responseMessage };
	}

	const inlineKeyboard = [];

	// GKYbot 解封操作
	if (banlistData.success && banlistData.banned) {
		const 黑白名单 = banlistData.chatId == GROUP_ID ? '移出黑名单' : '添加白名单';
		const copyText = `GKYbotSave\n${banlistData.tgid}`;
		if (options.actionInCurrentChat) {
			responseMessage += `\n👉 若同意 <b>${黑白名单} (GKYbot)</b>，请在本群发送下方复制的代码。`;
		} else {
			const groupInfo = await getGroupInfo();
			responseMessage += `\n👉 若同意 <b>${黑白名单} (GKYbot)</b>，请返回 ${escapeHtml(groupInfo.username)} 群组发送下方复制的代码。`;
		}
		inlineKeyboard.push([{ text: `📋 点击复制 ${黑白名单} 代码`, copy_text: { text: copyText } }]);
	}

	// 本地 KV 解封操作
	if (isLocalBlacklisted) {
		responseMessage += `\n👉 若同意 <b>解除本地黑名单</b>，请发送下方复制的解封命令。`;
		inlineKeyboard.push([{ text: `📋 点击复制 本地解封 命令`, copy_text: { text: `/unban ${tgidToCheck}` } }]);
	}

	const replyMarkup = inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined;

	return {
		text: responseMessage,
		replyMarkup
	};
}

const BOT_MODERATION_LOG_LABELS = {
	'new-members:found': '检测到新成员入群消息',
	'skip:new-members-not-target-chat': '跳过：新成员消息不在配置的 GROUP_ID 群',
	'skip:new-member-without-id': '跳过：新成员缺少用户 ID，无法处理',
	'skip:new-member-not-blacklisted': '跳过：新入群普通用户不在本地黑名单，正常放行',
	'skip:new-member-self': '跳过：新成员是当前机器人自己',
	'new-member-admin-status': '已查询新入群机器人在群里的身份',
	'skip:new-member-admin-status-check-failed': '跳过：无法确认新入群机器人是否为管理员，为避免误伤不处理',
	'skip:new-member-admin-bot': '跳过：新入群机器人是群管理员',
	'action:mute-new-bot:start': '开始处理：禁言新入群的非管理员机器人',
	'action:mute-new-bot:success': '处理成功：已禁言新入群的非管理员机器人',
	'action:mute-new-bot:failed': '处理失败：禁言新入群机器人失败',
	'action:ban-blacklisted-new-member:start': '开始处理：封禁新入群的黑名单用户',
	'action:ban-blacklisted-new-member:success': '处理成功：已封禁新入群的黑名单用户',
	'action:ban-blacklisted-new-member:failed': '处理失败：封禁新入群的黑名单用户失败',
	'skip:no-message-from': '跳过：消息没有 from 字段，无法按普通用户消息处理',
	'skip:self-bot-id-missing': '跳过：无法获取当前机器人的 ID，为避免误伤不处理',
	'telegram-api:restrictChatMember:response': 'Telegram接口返回：禁言'
};

function logBotModeration(step, details = {}) {
	const label = BOT_MODERATION_LOG_LABELS[step] || step;

	try {
		console.log(`[机器人风控] ${label}: ${JSON.stringify(details)}`);
	} catch (error) {
		console.log(`[机器人风控] ${label}: 日志详情序列化失败：${error.message}`);
	}
}

function getMessageLogInfo(message) {
	const sender = message?.from;
	const chat = message?.chat;

	return {
		消息ID: message?.message_id,
		聊天ID: chat?.id,
		聊天类型: chat?.type,
		配置GROUP_ID: GROUP_ID,
		发送者ID: sender?.id,
		发送者用户名: sender?.username,
		发送者昵称: sender?.first_name,
		发送者是否机器人: sender?.is_bot,
		文本预览: typeof message?.text === 'string' ? message.text.slice(0, 80) : null
	};
}

function getNewMemberLogInfo(message, member) {
	return {
		...getMessageLogInfo(message),
		新成员ID: member?.id,
		新成员用户名: member?.username,
		新成员昵称: member?.first_name,
		新成员是否机器人: member?.is_bot
	};
}

async function handleNewChatMemberBots(message, env) {
	const chat = message.chat;
	const newMembers = message.new_chat_members;

	if (!Array.isArray(newMembers) || newMembers.length === 0) {
		return false;
	}

	logBotModeration('new-members:found', {
		...getMessageLogInfo(message),
		新成员数量: newMembers.length
	});

	if (!chat || chat.id.toString() !== GROUP_ID.toString()) {
		logBotModeration('skip:new-members-not-target-chat', getMessageLogInfo(message));
		// 非 GROUP_ID 群:若 bot 是当前群管理员(且具备限制成员权限)→ 对入群真人成员执行
		// "联网黑名单自动查杀"(bot 身份/权限在函数内部判断,不满足则整群跳过,不误伤)。
		try {
			await handleNetworkBlacklistKill(chat, newMembers, env);
		} catch (error) {
			console.error('[机器人风控] 联网查杀(入群)异常:', error.message);
		}
		return true;
	}

	const currentBotId = await getBotId();
	if (!currentBotId) {
		logBotModeration('skip:self-bot-id-missing', getMessageLogInfo(message));
		return true;
	}

	for (const member of newMembers) {
		const logInfo = getNewMemberLogInfo(message, member);

		if (!member?.is_bot) {
			// 普通用户入群:检查本地 KV 黑名单,命中则立即封禁踢出(封禁语义闭环)。
			// checkBlacklist 仅读 env.KV(无外部 API 阻塞),开销可接受。
			if (!member?.id) {
				logBotModeration('skip:new-member-without-id', logInfo);
				continue;
			}
			try {
				const blacklistCheck = await checkBlacklist(member.id, env);
				if (blacklistCheck.isBlacklisted) {
					logBotModeration('action:ban-blacklisted-new-member:start', logInfo);
					await banUserPermanently(chat.id, member.id);
					logBotModeration('action:ban-blacklisted-new-member:success', logInfo);
					// 入群拦截封禁成功 → 标记该用户在本群状态为"封禁"
					await markUserGroupStatus(env, member.id, GROUP_MEMBER_STATUS.BANNED);
				} else {
					logBotModeration('skip:new-member-not-blacklisted', logInfo);
				}
			} catch (error) {
				logBotModeration('action:ban-blacklisted-new-member:failed', {
					...logInfo,
					错误: error.message
				});
			}
			continue;
		}

		if (member.id.toString() === currentBotId.toString()) {
			logBotModeration('skip:new-member-self', {
				...logInfo,
				当前机器人ID: currentBotId
			});
			continue;
		}

		let isAdmin = false;
		try {
			const statusResult = await checkUserStatus(member.id);
			const status = statusResult.result.status;
			isAdmin = status === 'creator' || status === 'administrator';
			logBotModeration('new-member-admin-status', {
				...logInfo,
				群成员状态: status,
				是否管理员: isAdmin
			});
		} catch (error) {
			logBotModeration('skip:new-member-admin-status-check-failed', {
				...logInfo,
				错误: error.message
			});
			continue;
		}

		if (isAdmin) {
			logBotModeration('skip:new-member-admin-bot', logInfo);
			continue;
		}

		try {
			logBotModeration('action:mute-new-bot:start', logInfo);
			await muteChatMember(chat.id, member.id);
			logBotModeration('action:mute-new-bot:success', logInfo);
		} catch (error) {
			logBotModeration('action:mute-new-bot:failed', {
				...logInfo,
				错误: error.message
			});
		}
	}

	return true;
}

async function handleMessage(message, env) {
	if (await handleNewChatMemberBots(message, env)) {
		return;
	}

	if (!message.from) {
		logBotModeration('skip:no-message-from', getMessageLogInfo(message));
		return;
	}

	const chatId = message.chat.id;
	const userId = message.from.id;
	const text = message.text;
	const username = message.from.username || message.from.first_name || '用户';

	// 联网黑名单自动查杀(消息路径):非 GROUP_ID 群内,真人发送的每条消息都过一遍查杀。
	// - 命令消息也会走到这里:命令发送者通常为本群管理员(不在 CM 黑名单)或已被 TG API
	//   拒绝禁言(管理员不可被 restrict),不会误杀;
	// - 触发条件(非 GROUP_ID 群 + bot 是群管理员且有限制成员权限 + 绑定 D1)在函数内部判断。
	if (chatId.toString() !== GROUP_ID.toString()) {
		try {
			await handleNetworkBlacklistKill(message.chat, [message.from], env);
		} catch (error) {
			console.error('[联网查杀] 消息路径异常:', error.message);
		}
	}

	// 处理管理员 /spam:
	// - GROUP_ID 群:添加被回复用户到 CM 黑名单(可同步修改 is_blacklisted);
	// - 非 GROUP_ID 群(bot 为该群管理员):仅本群禁言 + 状态"禁言",不修改 is_blacklisted。
	if (isSpamCommand(text)) {
		const isGroupIdChat = chatId.toString() === GROUP_ID.toString();
		if (!isGroupIdChat) {
			// 非 GROUP_ID 群:模式触发条件 = bot 是该群管理员;仅维护本群状态,不同步 CM 黑名单
			if (message.chat.type !== 'group' && message.chat.type !== 'supergroup') {
				return;
			}
			if (!isDbReady(env)) {
				return;
			}
			const botIsAdmin = await checkIfBotIsAdminInChat(chatId);
			if (!botIsAdmin) {
				return; // 模式未启用,保持原行为(不处理)
			}
			const isAdmin = await checkIfUserIsAdminInChat(userId, chatId);
			if (!isAdmin) {
				await sendTelegramMessage(chatId, '❌ <b>权限不足</b>\n\n此功能仅限本群管理员使用。');
				return;
			}
			const repliedUserId = message.reply_to_message?.from?.id;
			if (!repliedUserId) {
				await sendTelegramMessage(chatId, '❌ 请回复要禁言的用户消息后再发送 <code>/spam</code>');
				return;
			}
			try {
				await muteChatMember(chatId, repliedUserId);
				await dbSetUserGroupStatus(env, repliedUserId, chatId, GROUP_MEMBER_STATUS.MUTED);
				await sendTelegramMessage(chatId, `✅ 已在群内禁言 <a href="tg://user?id=${repliedUserId}">${repliedUserId}</a>\n📌 本群状态: 禁言`);
			} catch (error) {
				await sendTelegramMessage(chatId, `⚠️ 禁言失败: ${escapeHtml(error.message)}`);
			}
			return;
		}

		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) {
			// 备用通道:非管理员但拥有 /ad 权限(群助推者或 /ad 白名单)→ 按 /ad 举报投票逻辑处理
			const isBoosted = await checkIfUserBoosted(userId);
			const isAllowed = await isAdAllowlisted(env, userId);
			if (!isBoosted && !isAllowed) {
				// 两者都不是→完全静默
				return;
			}
			// 非管理员但拥有 /ad 权限 → 按 /ad 举报投票逻辑处理
			const adLikeMessage = { ...message, text: message.text.replace(/^\s*\/(?:spam|ban)(?:@[^\s]+)?/i, '/ad') };
			await handleAdCommand(adLikeMessage, env);
			return;
		}

		const repliedUserId = message.reply_to_message?.from?.id;
		if (!repliedUserId) {
			await sendTelegramMessage(chatId, '❌ 请回复要加入黑名单的用户消息后再发送 <code>/spam</code>');
			return;
		}

		const result = await addToBlacklist(repliedUserId, env, 'spam', message.from.id);
		const linkedUserId = `<a href="tg://user?id=${repliedUserId}">${repliedUserId}</a>`;

		if (result.success) {
			await sendTelegramMessage(chatId, `✅ 已将用户 ${linkedUserId} 添加到黑名单`);
		} else {
			await sendTelegramMessage(chatId, `${result.message}\nTG ID: ${linkedUserId}`);
		}
		return;
	}

	// 处理 GROUP_ID 群内管理员 /ad - 发起隐藏的举报投票
	if (isAdCommand(text)) {
		if (chatId.toString() !== GROUP_ID.toString()) {
			return;
		}
		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) {
			// 非管理员→检查助推者 / 白名单
			const isBoosted = await checkIfUserBoosted(userId);
			const isAllowed = await isAdAllowlisted(env, userId);
			if (!isBoosted && !isAllowed) {
				// 普通用户举报通道:回复消息 + /ad → 内容交 AI 评级,仅 A/B 才弹投票,其余完全静默
				const replyMsg = message.reply_to_message;
				const src = (typeof replyMsg?.text === 'string' && replyMsg.text.length > 0)
					? replyMsg.text
					: (typeof replyMsg?.caption === 'string' && replyMsg.caption.length > 0 ? replyMsg.caption : '');
				if (!src) {
					return; // 非回复方式或无文字内容 → 静默
				}
				const userReportAssessment = await assessThreatWithAI(env, src.slice(0, AD_AI_MAX_CONTENT_CHARS), AD_GROUP_RULES);
				console.log('[ad-user-report] 普通用户举报评级结果:', JSON.stringify(userReportAssessment ? {
					ok: userReportAssessment.ok, level: userReportAssessment.level, score: userReportAssessment.score
				} : null));
				if (!userReportAssessment?.ok) {
					return; // AI 失败/无法识别 → 静默
				}
				if (userReportAssessment.level !== 'A' && userReportAssessment.level !== 'B') {
					return; // C/D → 静默
				}
				// A/B → 按 /ad 逻辑弹投票(传入预评级,避免 handleAdCommand 内重复调用 AI)
				await handleAdCommand(message, env, userReportAssessment);
				return;
			}
		}
		await handleAdCommand(message, env);
		return;
	}

	// 管理员私聊: /add_ad_admin <tgid> — 添加热心群友白名单
	const addAdAdminCmd = parseCommand(text, 'add_ad_admin');
	if (addAdAdminCmd) {
		if (message.chat.type !== 'private') return;
		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) return;
		const tgid = addAdAdminCmd.firstArg;
		if (!tgid || !/^\d+$/.test(tgid)) {
			await sendTelegramMessage(chatId, '❌ 使用方法: <code>/add_ad_admin &lt;用户ID&gt;</code>');
			return;
		}
		const list = await getAdAdminList(env);
		if (list.some((id) => String(id) === tgid)) {
			await sendTelegramMessage(chatId, `⚠️ TGID <code>${escapeHtml(tgid)}</code> 已在白名单中`);
			return;
		}
		list.push(tgid);
		await saveAdAdminList(env, list);
		await sendTelegramMessage(chatId, `✅ 已将 <code>${escapeHtml(tgid)}</code> 加入 /ad 发起白名单`);
		return;
	}

	// 管理员私聊: /del_ad_admin <tgid> — 移除热心群友白名单
	const delAdAdminCmd = parseCommand(text, 'del_ad_admin');
	if (delAdAdminCmd) {
		if (message.chat.type !== 'private') return;
		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) return;
		const tgid = delAdAdminCmd.firstArg;
		if (!tgid || !/^\d+$/.test(tgid)) {
			await sendTelegramMessage(chatId, '❌ 使用方法: <code>/del_ad_admin &lt;用户ID&gt;</code>');
			return;
		}
		const list = await getAdAdminList(env);
		const idx = list.findIndex((id) => String(id) === tgid);
		if (idx === -1) {
			await sendTelegramMessage(chatId, `⚠️ TGID <code>${escapeHtml(tgid)}</code> 不在白名单中`);
			return;
		}
		list.splice(idx, 1);
		await saveAdAdminList(env, list);
		await sendTelegramMessage(chatId, `✅ 已将 <code>${escapeHtml(tgid)}</code> 从 /ad 发起白名单中移除`);
		return;
	}

	const checkCommand = parseCommand(text, 'check');
	// 处理管理员 /check - 支持回复用户或直接传入用户ID查询封禁状态
	if (checkCommand) {
		if (!isPrivateOrManagedGroup(message)) {
			return;
		}

		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) {
			return;
		}

		const repliedUser = message.reply_to_message?.from;
		const tgidToCheck = getCommandTargetUserId(checkCommand, message);
		if (!tgidToCheck) {
			await sendTelegramMessage(chatId, '❌ 使用方法: <code>/check 用户ID</code>，或在群内回复用户消息发送 <code>/check</code>');
			return;
		}

		if (!/^\d+$/.test(tgidToCheck)) {
			await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
			return;
		}

		await sendTelegramMessage(chatId, `正在查询 TGID: <code>${tgidToCheck}</code> 的封禁状态...`);
		let targetUser = null;
		if (!checkCommand.firstArg && repliedUser?.id?.toString() === tgidToCheck) {
			targetUser = repliedUser;
		} else {
			targetUser = await getManagedGroupUser(tgidToCheck);
		}

		const response = await buildBanlistCheckResponse(tgidToCheck, {
			targetUser,
			includeReviewAction: true,
			actionInCurrentChat: isManagedGroupMessage(message),
			env
		});
		await sendTelegramMessage(chatId, response.text, response.replyMarkup);
		return;
	}

	// 处理 /start 命令（包含 deep link 参数）
	if (text && text.startsWith('/start')) {
		// 检查是否有参数 (例如: /start check_8435016129)
		const parts = text.split(' ');
		if (parts.length > 1 && parts[1].startsWith('check_')) {
			// 验证用户是否是群组管理员
			const isAdmin = await checkIfUserIsAdmin(userId);

			if (!isAdmin) {
				const groupInfo = await getGroupInfo();
				await sendTelegramMessage(chatId, `❌ <b>权限不足</b>\n\n此功能仅限 ${groupInfo.title} 的管理员使用。`);
				return;
			}

			// 提取 TGID
			const tgidToCheck = parts[1].replace('check_', '');
			await sendTelegramMessage(chatId, `正在查询 TGID: <code>${tgidToCheck}</code> 的封禁状态...`);
			const response = await buildBanlistCheckResponse(tgidToCheck, { includeReviewAction: true, env });
			await sendTelegramMessage(chatId, response.text, response.replyMarkup);

			return;
		}

		// 普通的 /start 命令，显示欢迎消息
	}

	const banCommand = parseCommand(text, 'ban');
	// 处理 /ban 命令:
	// - GROUP_ID 群/私聊:添加用户到 CM 黑名单(可同步修改 is_blacklisted);
	// - 非 GROUP_ID 群(bot 为该群管理员):仅本群封禁踢出 + 状态"封禁",不修改 is_blacklisted。
	if (banCommand) {
		const isGroupIdChat = chatId.toString() === GROUP_ID.toString();
		const isGroupChat = message.chat.type === 'group' || message.chat.type === 'supergroup';

		// 非 GROUP_ID 群:模式触发条件 = bot 是该群管理员;仅维护本群状态,不同步 CM 黑名单
		if (isGroupChat && !isGroupIdChat) {
			if (!isDbReady(env)) {
				return;
			}
			const botIsAdmin = await checkIfBotIsAdminInChat(chatId);
			if (!botIsAdmin) {
				return; // 模式未启用,保持原行为(不处理)
			}
			const isAdmin = await checkIfUserIsAdminInChat(userId, chatId);
			if (!isAdmin) {
				await sendTelegramMessage(chatId, '❌ <b>权限不足</b>\n\n此功能仅限本群管理员使用。');
				return;
			}
			const targetUserId = getCommandTargetUserId(banCommand, message);
			if (!targetUserId) {
				await sendTelegramMessage(chatId, '❌ 使用方法: <code>/ban 用户ID</code>，或在群内回复用户消息发送 <code>/ban</code>');
				return;
			}
			if (!/^\d+$/.test(targetUserId)) {
				await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
				return;
			}
			try {
				await banUserPermanently(chatId, targetUserId);
				await dbSetUserGroupStatus(env, targetUserId, chatId, GROUP_MEMBER_STATUS.BANNED);
				await sendTelegramMessage(chatId, `✅ 已封禁 <a href="tg://user?id=${targetUserId}">${targetUserId}</a> 并移出本群\n📌 本群状态: 封禁`);
			} catch (error) {
				await sendTelegramMessage(chatId, `⚠️ 封禁失败: ${escapeHtml(error.message)}`);
			}
			return;
		}

		// 仅允许私聊或被管理的 GROUP_ID 群组内使用
		if (!isPrivateOrManagedGroup(message)) {
			return;
		}

		// 检查是否是群组管理员
		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) {
			// 备用通道:非管理员但拥有 /ad 权限(群助推者或 /ad 白名单)→ 按 /ad 举报投票逻辑处理
			const isBoosted = await checkIfUserBoosted(userId);
			const isAllowed = await isAdAllowlisted(env, userId);
			if (isBoosted || isAllowed) {
				// 按 /ad 举报投票逻辑处理;若为私聊,handleAdCommand 内部会静默 return(符合预期)
				const adLikeMessage = { ...message, text: message.text.replace(/^\s*\/(?:spam|ban)(?:@[^\s]+)?/i, '/ad') };
				await handleAdCommand(adLikeMessage, env);
				return;
			}
			// 两者都不是→保持原提示
			await sendTelegramMessage(chatId, '❌ <b>权限不足</b>\n\n此功能仅限群组管理员使用。');
			return;
		}

		// 提取要封禁的用户ID
		const targetUserId = getCommandTargetUserId(banCommand, message);
		if (!targetUserId) {
			await sendTelegramMessage(chatId, '❌ 使用方法: <code>/ban 用户ID</code>，或在群内回复用户消息发送 <code>/ban</code>');
			return;
		}

		if (!/^\d+$/.test(targetUserId)) {
			await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
			return;
		}

		// 添加到黑名单
		const result = await addToBlacklist(targetUserId, env, 'ban', message.from.id);
		let responseMessage = result.message;

		if (isManagedGroupMessage(message) && (result.success || result.alreadyExists)) {
			try {
				await muteChatMember(chatId, targetUserId);
				responseMessage += `\n✅ 已在群内禁言用户 <a href="tg://user?id=${targetUserId}">${targetUserId}</a>`;
				// 群内禁言成功 → 标记该用户在本群状态为"禁言"
				await markUserGroupStatus(env, targetUserId, GROUP_MEMBER_STATUS.MUTED);
			} catch (error) {
				console.error('群内禁言失败:', error);
				if (String(error.message).includes('PARTICIPANT_ID_INVALID')) {
					responseMessage = result.success
						? '✅ 已将用户加入黑名单\nℹ️ 该用户当前不在群内，未执行禁言'
						: `${responseMessage}\nℹ️ 该用户当前不在群内，未执行禁言`;
				} else {
					responseMessage += `\n⚠️ 黑名单已处理，但群内禁言失败: ${escapeHtml(error.message)}`;
				}
			}
		}

		await sendTelegramMessage(chatId, responseMessage);
		return;
	}

	const unbanCommand = parseCommand(text, 'unban');
	// 处理 /unban 命令:
	// - GROUP_ID 群/私聊:从 CM 黑名单移除(可同步修改 is_blacklisted);
	// - 非 GROUP_ID 群(bot 为该群管理员):本群白名单 + 解除封禁/禁言,不修改 is_blacklisted。
	if (unbanCommand) {
		const targetUserId = getCommandTargetUserId(unbanCommand, message);
		const isGroupIdChat = chatId.toString() === GROUP_ID.toString();
		const isGroupChat = message.chat.type === 'group' || message.chat.type === 'supergroup';

		// 非 GROUP_ID 群:白名单模式(仅维护本群状态,不同步 CM 黑名单)
		if (isGroupChat && !isGroupIdChat) {
			if (!isDbReady(env)) {
				return;
			}
			const botIsAdmin = await checkIfBotIsAdminInChat(chatId);
			if (!botIsAdmin) {
				return; // 模式未启用,保持原行为(不处理)
			}
			if (!targetUserId) {
				await sendTelegramMessage(chatId, '❌ 使用方法: <code>/unban 用户ID</code>，或回复用户消息发送 <code>/unban</code>');
				return;
			}
			const isAdmin = await checkIfUserIsAdminInChat(userId, chatId);
			if (!isAdmin) {
				await sendTelegramMessage(chatId, '❌ <b>权限不足</b>\n\n此功能仅限本群管理员使用。');
				return;
			}
			if (!/^\d+$/.test(targetUserId)) {
				await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
				return;
			}
			try {
				await unbanUserInChat(chatId, targetUserId);
				try {
					await restrictUserInChat(chatId, targetUserId);
				} catch (restoreError) {
					// 用户不在群内(如已被踢出且未重新加入)→ restrictChatMember 报错,忽略:
					// 白名单状态已记录,待其重新入群时不会触发查杀
					console.log('[联网查杀] 恢复发言权限跳过(用户不在群内):', restoreError.message);
				}
				await dbSetUserGroupStatus(env, targetUserId, chatId, GROUP_MEMBER_STATUS.WHITELISTED);
				await sendTelegramMessage(chatId, `✅ 已将 <a href="tg://user?id=${targetUserId}">${targetUserId}</a> 加入本群白名单，并解除封禁/禁言\n📌 本群状态: 白名单`);
			} catch (error) {
				await sendTelegramMessage(chatId, `⚠️ 操作失败: ${escapeHtml(error.message)}`);
			}
			return;
		}

		const shouldHandleAdminUnban = Boolean(targetUserId) || isGroupIdChat;

		// 有参数或群内回复用户时，处理黑名单移除。
		if (shouldHandleAdminUnban) {
			// 仅允许私聊或被管理的 GROUP_ID 群组内使用
			if (!isPrivateOrManagedGroup(message)) {
				return;
			}

			// 检查是否是群组管理员
			const isAdmin = await checkIfUserIsAdmin(userId);
			if (!isAdmin) {
				await sendTelegramMessage(chatId, '❌ <b>权限不足</b>\n\n此功能仅限群组管理员使用。');
				return;
			}

			if (!targetUserId) {
				await sendTelegramMessage(chatId, '❌ 使用方法: <code>/unban 用户ID</code>，或在群内回复用户消息发送 <code>/unban</code>');
				return;
			}

			if (!/^\d+$/.test(targetUserId)) {
				await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
				return;
			}

			// 从黑名单移除
			const result = await removeFromBlacklist(targetUserId, env, message.from.id);
			let responseMessage = result.message;

			if (result.success || result.notFound) {
				const restoreResult = await restoreUserInManagedGroup(targetUserId, env);
				responseMessage += `\n${restoreResult.message}`;
			}

			await sendTelegramMessage(chatId, responseMessage);
			return;
		}
	}

	// 处理 /start 和 /unban 命令 - 显示欢迎消息
	if (text === '/start' || text === '/unban') {
		// 检查黑名单
		const blacklistCheck = await checkBlacklist(userId, env);
		if (blacklistCheck.isBlacklisted) {
			await sendTelegramMessage(chatId, blacklistCheck.message);
			return;
		}

		const groupInfo = await getGroupInfo();
		const welcomeMessage = `🤖 <b>亲爱的 ${userId}</b>，我是 <b>${groupInfo.title}</b> 的 自助解封机器人

🔍 <b>请自行检查以下内容：</b>

1️⃣ 用户名是否包含广告内容？
2️⃣ 个人签名是否包含广告内容或链接？
3️⃣ 是否讨论了政治、NSFW、引战、嘲讽等内容？

✅ <b>如果你确定没有违反以上内容，请输入以下内容：</b>
	<code>我不是广告狗，我是误封的，希望可以解封。</code>`;

		await sendTelegramMessage(chatId, welcomeMessage);
	}
	// 检查用户回复是否包含必要内容
	else if (text && text.includes('我不是广告狗') && text.includes('我是误封的') && text.includes('希望可以解封')) {
		// KV 异常时保持放行策略：checkBlacklist 内部出错会返回 isBlacklisted=false
		const blacklistCheck = await checkBlacklist(userId, env);
		if (blacklistCheck.isBlacklisted) {
			await sendTelegramMessage(chatId, blacklistCheck.message);
			return;
		}

		// 发送确认消息
		const groupInfo = await getGroupInfo();
		await sendTelegramMessage(chatId, `✅ 已同意给予解封\n\n请点击 ${groupInfo.username} 返回群组\n\n⚠️ 请注意：解封后请遵守群规，避免再次被封禁。`);

		// 检查用户当前状态并采取相应操作
		try {
			const statusResult = await checkUserStatus(userId);
			const userStatus = statusResult.result.status;
			const userPermissions = statusResult.result.permissions || {};

			// 根据用户状态采取不同操作
			if (userStatus === 'kicked') {
				// 用户被封禁，需要解封
				await unbanUser(userId);
				await sendTelegramMessage(chatId, '✅ 您已被解封，可以重新加入群组。如果仍然无法发言，请联系管理员。');
				await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
				//await sendTelegramMessage(GROUP_ID, `${userId} 已通过自助解封`);
			} else if (userStatus === 'restricted') {
				// 用户被禁言，需要解除禁言
				await restrictUser(userId);
				await sendTelegramMessage(chatId, '✅ 您的禁言已解除，可以正常发言了。');
				await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
			} else if (userStatus === 'left' || userStatus === 'member') {
				// 用户已离开群组或已是成员，检查权限
				if (userPermissions.can_send_messages === false) {
					// 用户有发言限制，解除限制
					await restrictUser(userId);
					await sendTelegramMessage(chatId, '✅ 您的发言限制已解除，可以正常发言了。');
					await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
					//await sendTelegramMessage(GROUP_ID, `${userId} 已通过自助解禁`);
				} else {
					// 用户没有明显的限制
					await sendTelegramMessage(chatId, '✅ 检测到您的账号没有任何限制。如果仍然无法发言，请联系管理员。');
				}
			} else {
				// 其他状态，提示用户联系管理员
				await sendTelegramMessage(chatId, '❌ 无法确定您的账号状态。如果仍然无法发言，请联系管理员。');
			}
			// 检查用户是否在封禁黑名单中
			const TG黑名单 = await handleBanlist(userId);
			// 解析返回的 JSON 字符串
			const banlistData = JSON.parse(TG黑名单);
			if (banlistData.banned) {
				// 获取机器人用户名
				const botUsername = await getBotUsername();

				let infoMessage = `⚠️ 注意：您的账号存在封禁黑名单。\n`;
				infoMessage += `- TGID: <a href="tg://user?id=${banlistData.tgid}">${banlistData.tgid}</a>\n`;
				if (banlistData.reason) infoMessage += `- 封禁原因: ${banlistData.reason}\n`;
				infoMessage += `\n需要群组管理员进行<b><a href="https://t.me/${botUsername}?start=check_${banlistData.tgid}">二次审核</a></b>。`;
				await sendTelegramMessage(GROUP_ID, infoMessage);
			}
		} catch (error) {
			console.error('检查用户状态失败:', error);
			// 如果检查状态失败，回退到原来的逻辑
			try {
				// 首先尝试解除禁言（恢复发言权限）
				await restrictUser(userId);
				await sendTelegramMessage(chatId, '✅ 您的禁言已解除，可以正常发言了。如果仍然无法发言，请联系管理员。');
				await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
				await sendTelegramMessage(GROUP_ID, `用户 ${userId} 已通过自助解禁`);
			} catch (restrictError) {
				console.error('解除禁言失败:', restrictError);
				try {
					await unbanUser(userId);
					await sendTelegramMessage(chatId, '✅ 您已被解封，可以重新加入群组。如果仍然无法发言，请联系管理员。');
					await markUserGroupStatus(env, userId, GROUP_MEMBER_STATUS.HEALTHY);
					await sendTelegramMessage(GROUP_ID, `用户 ${userId} 已通过自助解禁`);
				} catch (unbanError) {
					console.error('解封失败:', unbanError);
					// 如果仍然失败，通知用户
					await sendTelegramMessage(
						chatId,
						`❌ 解封操作失败，请联系管理员\n\n` +
						`错误详情：\n` +
						`状态检查错误: ${error.message}\n` +
						`禁言解除错误: ${restrictError.message}\n` +
						`解封错误: ${unbanError.message}`
					);
				}
			}
		}
	}
}

// 发送 Telegram 消息
async function sendTelegramMessage(chatId, text, replyMarkup, replyToMessageId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
	const body = {
		chat_id: chatId,
		text: text,
		parse_mode: 'HTML',
		disable_web_page_preview: true
	};

	if (replyMarkup) {
		body.reply_markup = replyMarkup;
	}
	if (replyToMessageId) {
		body.reply_to_message_id = replyToMessageId;
	}

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	const result = await response.json();

	// 添加调试日志
	console.log(`发送消息到 Telegram，状态: ${response.status}, 响应: ${JSON.stringify(result)}`);

	return result;
}

// 应答 inline 按钮的回调,避免按钮一直转圈
async function answerCallbackQuery(callbackQueryId, text, showAlert = false) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
	const body = {
		callback_query_id: callbackQueryId
	};
	if (text) {
		body.text = text;
	}
	if (showAlert) {
		body.show_alert = true;
	}

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (!response.ok || !result.ok) {
			console.error('answerCallbackQuery 返回失败:', JSON.stringify(result));
		}
		return result;
	} catch (error) {
		console.error('answerCallbackQuery 调用失败:', error.message);
		return null;
	}
}

// 编辑已发送的消息文本与按钮(用于 /ad 投票刷新与结束)
async function editMessageText(chatId, messageId, text, replyMarkup) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
	const body = {
		chat_id: chatId,
		message_id: messageId,
		text,
		parse_mode: 'HTML',
		disable_web_page_preview: true
	};
	if (replyMarkup !== undefined) {
		body.reply_markup = replyMarkup;
	}

	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (!response.ok || !result.ok) {
			console.error('editMessageText 返回失败:', JSON.stringify(result));
		}
		return result;
	} catch (error) {
		console.error('editMessageText 调用失败:', error.message);
		return null;
	}
}

// 删除消息(用于 /ad 通过后清理被举报广告)
async function deleteMessage(chatId, messageId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
	const body = { chat_id: chatId, message_id: messageId };
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (!response.ok || !result.ok) {
			console.error('deleteMessage 失败:', JSON.stringify(result));
			return false;
		}
		console.log(`[/ad] 已删除被举报消息 ${messageId}`);
		return true;
	} catch (error) {
		console.error('deleteMessage 调用失败:', error.message);
		return false;
	}
}

// Telegram moderation helpers
async function muteChatMember(chatId, userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/restrictChatMember`;
	const body = {
		chat_id: chatId,
		user_id: userId,
		use_independent_chat_permissions: true,
		permissions: {
			can_send_messages: false,
			can_send_audios: false,
			can_send_documents: false,
			can_send_photos: false,
			can_send_videos: false,
			can_send_video_notes: false,
			can_send_voice_notes: false,
			can_send_polls: false,
			can_send_other_messages: false,
			can_add_web_page_previews: false,
			can_change_info: false,
			can_invite_users: false,
			can_pin_messages: false,
			can_manage_topics: false
		}
	};

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	const result = await response.json();
	logBotModeration('telegram-api:restrictChatMember:response', {
		聊天ID: chatId,
		用户ID: userId,
		HTTP状态码: response.status,
		是否成功: result.ok,
		返回说明: result.description
	});

	if (!response.ok || !result.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}

	console.log(`Muted user ${userId} in chat ${chatId}, response: ${JSON.stringify(result)}`);

	return result;
}

async function unbanUser(userId) {
	// GROUP_ID 群专用封装:委托通用版 unbanUserInChat(支持任意群,本处固定 GROUP_ID)
	return await unbanUserInChat(GROUP_ID, userId);
}

// 永久封禁用户(踢出群组并禁止重新加入)
async function banUserPermanently(chatId, userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/banChatMember`;
	const body = {
		chat_id: chatId,
		user_id: userId
	};

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	const result = await response.json();

	if (!response.ok || !result.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}

	console.log(`执行 banUserPermanently，chat=${chatId} user=${userId}, 响应: ${JSON.stringify(result)}`);
	return result;
}

// 解除用户禁言（恢复发言权限）— GROUP_ID 群专用封装
async function restrictUser(userId) {
	return await restrictUserInChat(GROUP_ID, userId);
}

// 检查用户在群组中的状态
async function checkUserStatus(userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
	const body = {
		chat_id: GROUP_ID,
		user_id: userId
	};

	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});

	const result = await response.json();

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}

	return result;
}

// 检查用户是否是群组管理员
async function checkIfUserIsAdmin(userId) {
	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
		const body = {
			chat_id: GROUP_ID,
			user_id: userId
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		const result = await response.json();

		if (!response.ok) {
			console.error('检查管理员权限失败:', result);
			return false;
		}

		// 检查用户状态是否为管理员或创建者
		const status = result.result.status;
		const isAdmin = status === 'creator' || status === 'administrator';

		// 添加调试日志
		console.log(`用户 ${userId} 的权限状态: ${status}, 是否为管理员: ${isAdmin}`);

		return isAdmin;
	} catch (error) {
		console.error('检查管理员权限时出错:', error);
		return false;
	}
}

// 管理员身份实例级缓存(带 TTL):供高频路径使用(recordUserActivity 每条群聊消息都调用,
// 直接打 getChatMember 会成倍消耗 Telegram API 配额)。管理员身份变动不频繁,TTL 内不感知。
// 60s 窗口内的身份变化(如刚被提升的管理员)最多延迟 60s 生效;降级同理,期间按旧身份处理。
const ADMIN_CHECK_CACHE_TTL_MS = 60000;
const groupAdminCache = new Map();
async function checkIfUserIsAdminCached(userId) {
	const tgid = String(userId);
	const now = Date.now();
	const cached = groupAdminCache.get(tgid);
	if (cached && (now - cached.fetchedAt) < ADMIN_CHECK_CACHE_TTL_MS) {
		return cached.isAdmin;
	}
	const isAdmin = await checkIfUserIsAdmin(tgid); // 内部已 catch 全部异常,失败返回 false
	groupAdminCache.set(tgid, { isAdmin, fetchedAt: now });
	return isAdmin;
}

// 检查用户是否助推过 GROUP_ID 群组(getUserChatBoosts 需要机器人是管理员)
async function checkIfUserBoosted(userId) {
	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUserChatBoosts`;
		const body = {
			chat_id: GROUP_ID,
			user_id: userId
		};

		console.log(`[/ad] getUserChatBoosts 请求: chat_id=${GROUP_ID}, user_id=${userId}`);

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		const result = await response.json();
		console.log(`[/ad] getUserChatBoosts 响应: HTTP=${response.status}, ok=${result.ok}, result=${JSON.stringify(result.result)}`);

		if (!response.ok || !result.ok) {
			console.error('[/ad] getUserChatBoosts 失败:', JSON.stringify(result));
			return false;
		}

		const boostCount = Array.isArray(result.result?.boosts) ? result.result.boosts.length : 0;
		console.log(`[/ad] 用户 ${userId} 当前有效助推数: ${boostCount}`);
		return boostCount > 0;
	} catch (error) {
		console.error('[/ad] 检查用户助推状态时出错:', error.message, error.stack);
		return false;
	}
}

// 获取机器人用户名
async function getBotId() {
	if (BOT_ID) {
		return BOT_ID;
	}

	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`;
		const response = await fetch(url);
		const result = await response.json();

		if (response.ok && result.result && result.result.id) {
			BOT_ID = result.result.id;
			if (result.result.username) {
				BOT_USERNAME = result.result.username;
			}
			return BOT_ID;
		}

		console.error('Failed to get bot ID:', result);
		return null;
	} catch (error) {
		console.error('Failed to get bot ID:', error);
		return null;
	}
}

async function getBotUsername() {
	// 如果已经缓存，直接返回
	if (BOT_USERNAME) {
		return BOT_USERNAME;
	}

	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getMe`;
		const response = await fetch(url);
		const result = await response.json();

		if (response.ok && result.result && result.result.username) {
			if (result.result.id) {
				BOT_ID = result.result.id;
			}
			BOT_USERNAME = result.result.username;
			console.log(`机器人用户名: ${BOT_USERNAME}`);
			return BOT_USERNAME;
		} else {
			console.error('获取机器人信息失败:', result);
			return 'CM_Unban_bot'; // 失败时返回默认值
		}
	} catch (error) {
		console.error('获取机器人用户名时出错:', error);
		return 'CM_Unban_bot'; // 失败时返回默认值
	}
}

// 获取群组信息
async function getGroupInfo() {
	// 如果已经缓存，直接返回
	if (GROUP_TITLE && GROUP_USERNAME) {
		return {
			title: GROUP_TITLE,
			username: GROUP_USERNAME
		};
	}

	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat`;
		const body = {
			chat_id: GROUP_ID
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		const result = await response.json();

		if (response.ok && result.result) {
			GROUP_TITLE = result.result.title || 'CM技术交流群';
			GROUP_USERNAME = result.result.username ? `@${result.result.username}` : '@CMLiussss';
			console.log(`群组信息: 名称=${GROUP_TITLE}, 用户名=${GROUP_USERNAME}`);
			return {
				title: GROUP_TITLE,
				username: GROUP_USERNAME
			};
		} else {
			console.error('获取群组信息失败:', result);
			// 失败时返回默认值
			return {
				title: 'CM技术交流群',
				username: '@CMLiussss'
			};
		}
	} catch (error) {
		console.error('获取群组信息时出错:', error);
		// 失败时返回默认值
		return {
			title: 'CM技术交流群',
			username: '@CMLiussss'
		};
	}
}

async function handleBanlist(chatId) {
	function parseBanlistHTML(html, tgid) {
		// 检查是否没有封禁记录
		const noRecordPattern = /并沒有封鎖記錄|has no ban record/;
		if (noRecordPattern.test(html)) {
			return {
				success: true,
				banned: false,
				tgid: tgid,
				message: '此TG帳號并沒有封鎖記錄 / This TG account has no ban record'
			};
		}

		// 提取封禁信息
		const result = {
			success: true,
			banned: true,
			tgid: null,
			chatId: null,
			msgId: null,
			reason: null,
			info: null,
			recordedDate: null
		};

		// 提取 Recorded Date
		const dateMatch = html.match(/Recorded Date:\s*([^<]+)/);
		if (dateMatch) {
			result.recordedDate = dateMatch[1].trim();
		}

		// 提取 TGID
		const tgidMatch = html.match(/<strong>TGID:<\/strong>\s*(\d+)/);
		if (tgidMatch) {
			result.tgid = tgidMatch[1];
		}

		// 提取 ChatID
		const chatIdMatch = html.match(/<strong>ChatID:<\/strong>\s*(-?\d+)/);
		if (chatIdMatch) {
			result.chatId = chatIdMatch[1];
		}

		// 提取 MsgID
		const msgIdMatch = html.match(/<strong>MsgID:<\/strong>\s*(\d+)/);
		if (msgIdMatch) {
			result.msgId = msgIdMatch[1];
		}

		// 提取 Reason
		const reasonMatch = html.match(/<strong>Reason:<\/strong>\s*([^<]+)/);
		if (reasonMatch) {
			const rawReason = reasonMatch[1].trim();
			// 映射封禁原因为中文
			const reasonMap = {
				'SpamGP': '群众举报',
				'ExReply': '违规转发',
				'Ad Image': '违规图片',
				'UserName': '违规用户名/签名'
			};
			result.reason = reasonMap[rawReason] || rawReason;
		}

		// 提取 Info (封禁的消息内容)
		const infoMatch = html.match(/<strong>Info:<\/strong><\/p>\s*([^<]+(?:<br[^>]*>[^<]*)*)/);
		if (infoMatch) {
			// 清理 HTML 标签并提取文本内容
			let info = infoMatch[1];
			info = info.replace(/<br\s*\/?>/gi, '\n'); // 将 <br> 替换为换行符
			info = info.replace(/<[^>]+>/g, ''); // 移除其他 HTML 标签
			info = info.trim();
			result.info = info;
		} else {
			// 尝试另一种匹配模式,匹配 Info 后的内容直到 </p> 或 <br>
			const infoMatch2 = html.match(/<strong>Info:<\/strong><\/p>\s*([\s\S]*?)<br>/);
			if (infoMatch2) {
				let info = infoMatch2[1];
				info = info.replace(/<br\s*\/?>/gi, '\n');
				info = info.replace(/<[^>]+>/g, '');
				info = info.trim();
				result.info = info;
			}
		}

		return result;
	}

	if (!chatId) {
		return JSON.stringify({
			success: false,
			error: 'Missing tgid parameter'
		});
	}

	// 访问原始的 banlist API
	const targetUrl = `https://gkybot.gmeow.cc/banlist?tgid=${chatId}`;
	const response = await fetch(targetUrl);
	const html = await response.text();

	// 解析 HTML 内容
	const result = parseBanlistHTML(html, chatId);

	return JSON.stringify(result);
}

// 通过群组ID获取群组信息
async function getChatInfoFromId(chatId) {
	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat`;
		const body = {
			chat_id: chatId
		};

		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});

		const result = await response.json();

		if (response.ok && result.result) {
			const title = result.result.title || result.result.first_name || null;
			const username = result.result.username;

			// 构建返回对象
			const info = {
				title: title
			};

			// 如果有用户名，构建链接
			if (username) {
				info.link = `https://t.me/${username}`;
			}

			return info;
		} else {
			console.error('获取群组信息失败:', result);
			return null;
		}
	} catch (error) {
		console.error('获取群组信息时出错:', error);
		return null;
	}
}

// ========================================================
// /ad 举报投票 - 实现函数
// ========================================================

function isAdCommand(text) {
	if (!text) {
		return false;
	}
	const trimmed = text.trim();
	// 接受 /ad 和 /ad@任意机器人用户名,与 /spam 解析规则保持一致
	return /^\/ad(?:@[^\s]+)?(?:\s|$)/i.test(trimmed);
}

function parseAdCommand(text) {
	if (!text) {
		return null;
	}
	const trimmed = text.trim();
	const match = trimmed.match(/^\/ad(?:@[^\s]+)?(?:\s+([\s\S]*))?$/i);
	if (!match) {
		return null;
	}
	const args = (match[1] || '').trim();
	return {
		args,
		firstArg: args.split(/\s+/)[0] || ''
	};
}

// 快照化一个 Telegram user 对象,便于 KV 持久化与跨会话显示
function snapshotTelegramUser(user) {
	if (!user || user.id === undefined || user.id === null) {
		return null;
	}
	return {
		id: user.id,
		firstName: user.first_name || '',
		lastName: user.last_name || '',
		username: user.username || '',
		bio: user.bio || '',
		isBot: Boolean(user.is_bot)
	};
}

// 把 snapshot 转回 Telegram user 形状,以便复用 formatUserMention
function snapshotToTelegramUser(snap) {
	if (!snap || snap.id === undefined || snap.id === null) {
		return null;
	}
	return {
		id: snap.id,
		first_name: snap.firstName || '',
		last_name: snap.lastName || '',
		username: snap.username || '',
		bio: snap.bio || '',
		is_bot: Boolean(snap.isBot)
	};
}

// 拼接被举报用户的资料文本(昵称/用户名/简介),用于发给 AI 判断。
// 广告常把推广内容藏匿在昵称和简介里,故一并纳入判断范围。
function buildUserProfileText(snap) {
	if (!snap) {
		return '';
	}
	const parts = [];
	const displayName = [snap.firstName, snap.lastName].filter(Boolean).join(' ') || snap.username || '';
	if (displayName) {
		parts.push(`昵称: ${displayName}`);
	}
	if (snap.username) {
		parts.push(`用户名: @${snap.username}`);
	}
	if (snap.bio) {
		parts.push(`个人简介: ${snap.bio}`);
	}
	return parts.join('\n');
}

// 尽力获取用户简介:getChatMember 的 User 对象不含 bio,
// 仅当被举报人私聊过本机器人时,getChat(chat_id=user_id) 才可能返回 bio。
// 失败静默返回 null,不阻塞主流程。
async function fetchUserBio(userId) {
	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChat`;
		const body = { chat_id: String(userId) };
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (response.ok && result?.ok && result.result?.bio) {
			return String(result.result.bio).slice(0, 200);
		}
		return null;
	} catch (error) {
		console.log('[/ad] 获取用户简介失败(不影响主流程):', error.message);
		return null;
	}
}

// 渲染一条投票人列表(逗号分隔的可点击 mention),空列表显示"无"
function formatVoterList(voters) {
	if (!Array.isArray(voters) || voters.length === 0) {
		return '无';
	}
	const mentions = voters
		.map((snap) => formatUserMention(snapshotToTelegramUser(snap)))
		.filter(Boolean);
	if (mentions.length === 0) {
		return '无';
	}
	return mentions.join(', ');
}

async function getAdVoteState(env, voteToken) {
	if (!env.KV) {
		return null;
	}
	try {
		const raw = await env.KV.get(`ad_vote:${voteToken}`, { type: 'json' });
		return raw;
	} catch (error) {
		console.error('[/ad] 读取投票状态失败:', error.message);
		return null;
	}
}

async function saveAdVoteState(env, state) {
	if (!env.KV) {
		return false;
	}
	const key = state.voteToken || `msg_${state.messageId}`;
	try {
		await env.KV.put(`ad_vote:${key}`, JSON.stringify(state), {
			expiration_ttl: AD_VOTE_TTL_SECONDS
		});
		return true;
	} catch (error) {
		console.error('[/ad] 保存投票状态失败:', error.message);
		return false;
	}
}

// ---- /add_ad_admin /del_ad_admin 热心群友白名单 ----

async function getAdAdminList(env) {
	// D1 优先:绑定数据库后走 DB 层(can_report 字段);未绑定则回退 KV
	if (isDbReady(env)) {
		return await dbGetAdAdminList(env);
	}

	if (!env.KV) return [];
	try {
		const list = await env.KV.get('ad_admin_list', { type: 'json' });
		return Array.isArray(list) ? list : [];
	} catch (error) {
		console.error('[/ad] 读取 ad_admin_list 失败:', error.message);
		return [];
	}
}

async function saveAdAdminList(env, list) {
	// D1 优先:绑定数据库后走 DB 层;未绑定则回退 KV
	if (isDbReady(env)) {
		return await dbSaveAdAdminList(env, list);
	}

	if (!env.KV) return false;
	try {
		await env.KV.put('ad_admin_list', JSON.stringify(list));
		return true;
	} catch (error) {
		console.error('[/ad] 保存 ad_admin_list 失败:', error.message);
		return false;
	}
}

async function isAdAllowlisted(env, userId) {
	// D1 优先:单行查询 can_report(免整表扫描);未绑定则回退 KV 数组
	if (isDbReady(env)) {
		return await dbIsAdAllowlisted(env, userId);
	}

	const list = await getAdAdminList(env);
	return list.some((id) => String(id) === String(userId));
}

// 脱敏显示名:只保留首字符和尾字符,中间固定用 *** 替代。
// 必须用 Array.from 按 Unicode 码点拆分,否则 emoji / 生僻字(如"𠮷")会被截断成乱码。
function maskDisplayName(name) {
	if (name === undefined || name === null) {
		return '';
	}
	const chars = Array.from(String(name));
	if (chars.length === 0) {
		return '';
	}
	if (chars.length === 1) {
		return '***'; // 单字符无"首尾"之分,整体隐藏最安全
	}
	return chars[0] + '***' + chars[chars.length - 1];
}

// 构造被举报人显示文本。
// mask=false:显示完整名称(投票进行中/被否决时,群成员需看到完整名称再投票);
// mask=true :投票通过确认其为广告号后,名称本身很可能含广告内容,需脱敏显示,防止广告二次传播。
function buildAdTargetText(state, mask) {
	if (!mask) {
		return formatUserMention(snapshotToTelegramUser(state.targetUserSnapshot))
			|| `<code>${escapeHtml(state.targetUserId)}</code>`;
	}
	const snap = state.targetUserSnapshot;
	const displayName = [snap?.firstName, snap?.lastName].filter(Boolean).join(' ')
		|| snap?.username || '';
	if (!displayName) {
		// 无显示名称时回退为 TGID,TGID 本身无广告内容,不脱敏
		return `<code>${escapeHtml(state.targetUserId)}</code>`;
	}
	// 脱敏后仍保留可点击链接,方便管理员核对
	return `<a href="tg://user?id=${escapeHtml(state.targetUserId)}">${escapeHtml(maskDisplayName(displayName))}</a>`;
}

function buildAdVoteMessageText(state) {
	const isApproved = state.result === 'approved';
	const isRejected = state.result === 'rejected';
	const isCancelled = state.result === 'cancelled';

	const approverCount = state.approvers.length;
	const rejecterCount = state.rejecters.length;

	const deadlineDate = new Date(state.deadlineAt * 1000 + 8 * 3600 * 1000); // 北京时间
	const pad = (n) => String(n).padStart(2, '0');
	const deadlineStr = `${deadlineDate.getUTCFullYear()}-${pad(deadlineDate.getUTCMonth() + 1)}-${pad(deadlineDate.getUTCDate())} ${pad(deadlineDate.getUTCHours())}:${pad(deadlineDate.getUTCMinutes())}:${pad(deadlineDate.getUTCSeconds())}`;

	let resultLine = '';
	if (state.finalized) {
		if (isApproved) {
			resultLine = '💀 <b>举报通过</b>\n';
		} else if (isRejected) {
			resultLine = '❎ <b>已被否决</b>\n';
		} else if (isCancelled) {
			resultLine = '🗑️ <b>发起人已放弃举报</b>\n';
		}
	}

	let vetoLine = '';
	if (state.vetoedBy) {
		const vetoerText = formatUserMention(snapshotToTelegramUser(state.vetoedBy))
			|| `<code>${escapeHtml(state.vetoedBy.id)}</code>`;
		vetoLine = `⚡ 管理员 ${vetoerText} 一票${isApproved ? '通过' : '否决'}\n`;
	}

	const statusLine = state.finalized ? '<i>已结束。</i>' : '<i>进行中...</i>';

	// 投票通过确认其为广告号后,名称本身很可能含广告内容,需脱敏显示,防止广告二次传播
	const mask = state.finalized && isApproved;
	const targetText = buildAdTargetText(state, mask);
	const creatorText = formatUserMention(snapshotToTelegramUser(state.creatorUserSnapshot))
		|| `<code>${escapeHtml(state.creatorUserId)}</code>`;

	let actionLine = '';
	if (state.finalized && isApproved) {
		actionLine = `\n✅ <b>已封禁:</b> ${targetText}\n`;
	} else if (state.finalized && isRejected) {
		actionLine = `\n❎ <i>举报未通过，未处理</i>\n`;
	} else if (state.finalized && isCancelled) {
		actionLine = `\n🚫 <i>发起人放弃举报，未处理</i>\n`;
	}

	// 威胁评级与生效阈值(兼容旧 KV 状态:无评级字段时按 C 可疑 / 存储阈值兜底)
	const rating = AD_THREAT_RATINGS[state.threatLevel] || AD_THREAT_RATINGS.C;
	const threatLabel = state.threatLabel || rating.label;
	const threshold = state.threshold || AD_VOTE_THRESHOLD;
	const rejectThreshold = state.rejectThreshold || threshold; // 反对阈值,旧状态缺省=赞成阈值

	return `⚠️ <b>#广告举报</b>
${resultLine}${vetoLine}
<b>被举报人:</b> ${targetText}
<b>被举报ID:</b> <code>${escapeHtml(state.targetUserId)}</code>
<b>发起人:</b> ${creatorText}

<b>威胁评级:</b> <b>${escapeHtml(threatLabel)}</b>
<b>截止时间:</b> <code>${escapeHtml(deadlineStr)}</code>

<b>赞成:</b> ${approverCount}/${threshold}
<b>反对:</b> ${rejecterCount}/${rejectThreshold}

<b>赞成:</b> ${formatVoterList(state.approvers)}
<b>反对:</b> ${formatVoterList(state.rejecters)}
${actionLine}
${statusLine}`;
}

function buildAdVoteInlineKeyboard(voteToken, state) {
	const threshold = state.threshold || AD_VOTE_THRESHOLD;
	const rejectThreshold = state.rejectThreshold || threshold;
	return {
		inline_keyboard: [[
			{
				text: `赞成 ${state.approvers.length}/${threshold}`,
				callback_data: `${AD_VOTE_BUTTON_PREFIX}A:${voteToken}`
			},
			{
				text: `反对 ${state.rejecters.length}/${rejectThreshold}`,
				callback_data: `${AD_VOTE_BUTTON_PREFIX}R:${voteToken}`
			}
		]]
	};
}

// ---- AI 威胁评级 ----

// 分数 → 评级:0~30=D,31~60=C,61~80=B,81~100=A(分数越高越危险)
function scoreToRating(score) {
	if (score >= 81) return AD_THREAT_RATINGS.A;
	if (score >= 61) return AD_THREAT_RATINGS.B;
	if (score >= 31) return AD_THREAT_RATINGS.C;
	return AD_THREAT_RATINGS.D;
}

// 构造发给 AI 的 system prompt:将群规按分隔符拆分为编号列表(便于 AI 在 reason 中引用编号),
// 并告知判定步骤/评级标准/输出格式,要求只输出 JSON。
// 群规拆分规则:按 顿号(、)、管道符(|)、中文/英文逗号(，,)、中文/英文分号(；;)、换行 拆分;
// 拆分后不足 2 项时(如管理员自定义单段长文本)回退用原文。
function buildAiSystemPrompt(groupRules) {
	const parts = String(groupRules || '')
		.split(/[、，,;；\n|]/)
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	let numberedRules = groupRules;
	if (parts.length >= 2) {
		numberedRules = parts.map((item, index) => `${index + 1}. ${item}`).join('\n');
	}
	return `你是群管理员举报审核助手。群规如下（编号供引用）：
${numberedRules}

判定步骤（严格按顺序）：
1. 先判断被举报内容是否明确违反任一编号群规；若违反，记住违规类别；
2. 再判断严重程度：同时违反多条、或涉及 NSFW/诈骗/恶意骚扰/邪教/涉政等严重类别 → 上调一档；
3. 若无法确定是否违规，选 C，不要选 B；
4. 若未违反群规或仅轻微无关，选 D；不要因为"可能""疑似"而提高评级；
5. 被举报用户的昵称/用户名/简介属于被举报内容的一部分，其中出现的广告、诈骗等违规信息同样判违规；但不得依据被举报人的身份/职业等正常信息（如"自由职业""博主"）判定违规，也不得依据举报人身份或历史消息。

评级标准：
- A 高危（严重违规）：明确违反群规且性质严重（NSFW、诈骗、恶意骚扰、邪教、涉政）
- B 危险（明显违规）：明确违反群规但情节一般（广告推销、引战、嘲讽引战）
- C 可疑（疑似违规）：疑似擦边/疑似广告/语气引战，但证据不足
- D 无害（未违规）：未违反群规或仅轻微无关

注意：被举报内容可能因长度被截断，请依据可见内容判断；截断导致无法判断时选 C。

只输出 JSON，禁止输出 markdown 代码围栏或任何解释，格式：
{"level": "A|B|C|D", "score": <0~100整数，越高越危险；区间 A=81~100、B=61~80、C=31~60、D=0~30>, "reason": "<30字以内，说明违反的编号群规；D 写'未违反群规'>"}

示例：
被举报消息：加微信 xxx 免费领福利，先到先得
输出：{"level": "B", "score": 66, "reason": "违反群规5：广告推销"}
被举报消息：哈哈哈哈哈哈哈
输出：{"level": "D", "score": 6, "reason": "未违反群规"}
被举报消息：你是傻逼，滚出这个群
输出：{"level": "A", "score": 88, "reason": "违反群规3/4：恶意攻击引战"}`;
}

// 容错解析 AI 返回的 JSON(兼容 markdown 代码围栏 / 前后多余文本 / 中文键名)
function parseAiThreatJson(text) {
	if (!text) return null;
	let cleaned = String(text).replace(/```(?:json)?/gi, '').trim();
	// 1) 直接解析
	try {
		const obj = JSON.parse(cleaned);
		if (obj && obj.score !== undefined) return obj;
	} catch (_) { }
	// 2) 截取首个 { 到最后一个 }
	const start = cleaned.indexOf('{');
	const end = cleaned.lastIndexOf('}');
	if (start !== -1 && end > start) {
		try {
			const obj = JSON.parse(cleaned.slice(start, end + 1));
			if (obj && obj.score !== undefined) return obj;
		} catch (_) { }
	}
	// 3) 正则兜底提取 score 与 reason
	const scoreMatch = cleaned.match(/(?:score|分数|评分)\D{0,12}?(\d{1,3})/i);
	const reasonMatch = cleaned.match(/(?:reason|理由|原因)\D{0,12}?["'：:]\s*([^"'\n]{1,80})/i);
	if (scoreMatch) {
		return { score: parseInt(scoreMatch[1], 10), reason: reasonMatch ? reasonMatch[1].trim() : '无理由' };
	}
	return null;
}

// 按模型类型构造 env.AI.run 的调用参数:
// - OpenAI 系(@cf/openai/*,如 gpt-oss-20b)→ Responses API:instructions(system)+ input(user)
// - 其它模型(llama/glm/qwen 等传统 Chat 模型)→ messages 数组
function buildAiRunOptions(model, systemPrompt, userContent) {
	if (String(model).startsWith('@cf/openai/')) {
		return {
			instructions: systemPrompt,
			input: [{ role: 'user', content: userContent }]
		};
	}
	return {
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userContent }
		]
	};
}

// 从各种模型的返回结构中提取文本,兼容:
// - 传统 Chat:{ response } / { result: { response } } / { result: 字符串 }
// - Responses API(gpt-oss):{ output: [{ type:'message', content: [{ type:'output_text', text }] }] }
//   / { output: [{ output_text }] } / { output_text }
// - OpenAI Chat Completions:{ choices: [{ message: { content } }] } / { choices: [{ text }] }
function extractAiResponseText(result) {
	if (typeof result === 'string') return result;
	if (!result || typeof result !== 'object') return '';
	if (typeof result.response === 'string') return result.response;
	if (result.result && typeof result.result.response === 'string') return result.result.response;
	if (result.result && typeof result.result === 'string') return result.result;
	if (Array.isArray(result.output)) {
		const parts = [];
		for (const item of result.output) {
			if (!item || typeof item !== 'object') continue;
			if (typeof item.output_text === 'string') parts.push(item.output_text);
			if (typeof item.text === 'string') parts.push(item.text);
			if (Array.isArray(item.content)) {
				for (const c of item.content) {
					if (c && typeof c === 'object' && typeof c.text === 'string') parts.push(c.text);
				}
			}
		}
		if (parts.length > 0) return parts.join('');
	}
	if (typeof result.output_text === 'string') return result.output_text;
	if (Array.isArray(result.choices) && result.choices.length > 0) {
		const first = result.choices[0];
		if (first) {
			if (typeof first.text === 'string') return first.text;
			if (first.message && typeof first.message.content === 'string') return first.message.content;
		}
	}
	return '';
}

// 调用 Workers AI 判断威胁评级(单模型)。返回三态:
// - 成功:{ ok: true, level, label, score, reason, threshold }
// - AI 有响应但无法识别/拒绝答复:{ ok: false, code: 'unrecognized' }
//   → 调用方按 🟡B 危险处理(内容可能触发了安全策略拒答;
//     含 AI 调用抛"内容安全拒绝"类异常——能触发道德围栏本身就是高危信号)
// - 基础设施失败(无 AI 绑定 / 超时 / 网络 / 限流等,不含内容安全拒绝):null
//   → 调用方按 🟢C 可疑中性回退
// 所有诊断日志以 [ad-ai] 前缀输出,Cloudflare Workers Logs 中可按前缀 grep 定位。
async function assessThreatWithAI(env, content, groupRules) {
	// 入口诊断:env/AI 绑定状态、消息长度、模型名
	console.log('[ad-ai] === 评估入口 ===', JSON.stringify({
		hasEnv: Boolean(env),
		hasAIBinding: Boolean(env && env.AI),
		aiType: env?.AI ? typeof env.AI : 'undefined',
		hasRunMethod: env?.AI ? typeof env.AI.run : 'undefined',
		model: AD_AI_MODEL,
		contentLength: content ? content.length : 0,
		contentPreview: content ? content.slice(0, 80).replace(/\n/g, '\\n') : '',
		rulesLength: (groupRules || AD_GROUP_RULES).length,
		timeoutMs: AD_AI_TIMEOUT_MS
	}));

	if (!env?.AI) {
		console.error('[ad-ai] env.AI 未绑定 —— 请确认 wrangler.toml 包含 [ai] binding = "AI" 且已重新 wrangler deploy,Dashboard 中该 Worker 也有 AI 绑定资源');
		return null;
	}
	if (typeof env.AI.run !== 'function') {
		console.error('[ad-ai] env.AI.run 不是函数 —— AI 绑定类型异常,实际类型:', typeof env.AI.run, ',env.AI 完整结构:', JSON.stringify(Object.keys(env.AI || {})));
		return null;
	}
	if (!content) {
		console.log('[ad-ai] 无被举报内容,跳过 AI 调用');
		return null;
	}

	const systemPrompt = buildAiSystemPrompt(groupRules || AD_GROUP_RULES);
	const userContent = `被举报消息内容:\n${content}`;
	const runOptions = buildAiRunOptions(AD_AI_MODEL, systemPrompt, userContent);

	console.log('[ad-ai] 准备调用 env.AI.run, model=' + AD_AI_MODEL + ', 参数键=' + Object.keys(runOptions).join(',') + ', 超时=' + AD_AI_TIMEOUT_MS + 'ms');

	let timerId;
	try {
		const result = await Promise.race([
			env.AI.run(AD_AI_MODEL, runOptions),
			new Promise((_, reject) => {
				timerId = setTimeout(
					() => reject(new Error('AI 调用超时(>' + AD_AI_TIMEOUT_MS + 'ms)')),
					AD_AI_TIMEOUT_MS
				);
			})
		]);
		if (timerId) clearTimeout(timerId);

		// 完整打印 AI.run 原始返回(便于诊断格式异常),截断 500 字符
		let rawStr;
		try {
			rawStr = JSON.stringify(result);
		} catch (jsonErr) {
			rawStr = '[无法 JSON.stringify] typeof=' + typeof result + ', String()=' + String(result);
		}
		console.log('[ad-ai] AI.run 已返回, 截断 500:', rawStr.slice(0, 500));

		// 多格式提取文本(传统 Chat / Responses API / Chat Completions)
		const text = extractAiResponseText(result);
		console.log('[ad-ai] 提取的 response 文本: 长度=' + text.length + ', 前300字符=' + text.slice(0, 300));

		if (!text || !text.trim()) {
			console.error('[ad-ai] AI 返回空文本(可能被安全策略拒答或模型静默,或返回结构未适配) → 按 B 危险处理。原始返回:', rawStr.slice(0, 500));
			return { ok: false, code: 'unrecognized' };
		}
		const parsed = parseAiThreatJson(text);
		if (!parsed) {
			console.error('[ad-ai] AI 返回无法解析为 JSON(可能为拒答/乱码/格式错误) → 按 B 危险处理。完整 text:', text);
			return { ok: false, code: 'unrecognized' };
		}
		const score = Math.round(Number(parsed.score));
		if (!Number.isFinite(score)) {
			console.error('[ad-ai] AI 解析出的分数非数字 → 按 B 危险处理。parsed:', JSON.stringify(parsed));
			return { ok: false, code: 'unrecognized' };
		}
		const clampedScore = Math.max(0, Math.min(100, score));
		const rating = scoreToRating(clampedScore);
		console.log('[ad-ai] 解析成功: score=' + clampedScore + ' → 评级=' + rating.level + ' ' + rating.label + ' → 票数=' + rating.votes + ', reason="' + (parsed.reason || '') + '"');
		return {
			ok: true,
			level: rating.level,
			label: rating.label,
			score: clampedScore,
			reason: String(parsed.reason || '').slice(0, 80) || '未提供理由',
			threshold: rating.votes
		};
	} catch (error) {
		if (timerId) clearTimeout(timerId);
		const isTimeout = error && error.message && error.message.includes('AI 调用超时');
		// 内容安全拒绝检测:能触发道德围栏(如 NSFW)本身就是"内容足够劲爆"的强信号,
		// 模型/API 常因此直接抛 400/403 或安全策略报错 → 与拒答同等对待,按 B 危险处理。
		// 超时永远不算内容拒绝(超时不携带内容违规信息),即使 message 含其它词也保持 null→C。
		const SAFETY_PATTERN = /(?:content|safety|policy|filter|moderat|block|inappropriat|disallow|NSFW|400|403)/i;
		const isSafetyRejection = !isTimeout && Boolean(error?.message) && SAFETY_PATTERN.test(error.message);
		if (isSafetyRejection) {
			console.error('[ad-ai] AI.run 疑似触发道德围栏/内容安全拒绝 → 按 B 危险处理。诊断信息:', JSON.stringify({
				isTimeout,
				errorName: error?.name,
				errorMessage: error?.message,
				errorStackHead: (error?.stack || '').split('\n').slice(0, 4).join(' | ')
			}));
			return { ok: false, code: 'unrecognized' };
		}
		console.error('[ad-ai] AI.run 抛异常(基础设施失败:超时/网络/限流/未知) → 回退 C 可疑。诊断信息:', JSON.stringify({
			isTimeout,
			errorName: error?.name,
			errorMessage: error?.message,
			errorStackHead: (error?.stack || '').split('\n').slice(0, 4).join(' | ')
		}));
		return null;
	}
}

// 预检目标用户在本群(GROUP_ID)是否已被禁言或被 ban(mutedOrBanned)且已存在于本地 KV 黑名单(isBlacklisted)。
// 仅当两者同时成立时判定为"重复操作"(shouldSkip=true),由调用方跳过本次举报投票。
// 注意:checkUserStatus 调用 Telegram getChatMember,当用户不在群里(被踢/退群/从未入群)或网络异常时会抛异常;
// 异常时按 mutedOrBanned=false 处理(fail-open 放行,不阻断正常举报)。checkBlacklist 内部已兜底"未绑定 KV / 读取异常"两种情况。
async function checkAdDuplicate(tgid, env) {
	let mutedOrBanned = false;
	try {
		const statusResult = await checkUserStatus(tgid);
		const status = statusResult?.result?.status;
		const canSendMessages = statusResult?.result?.can_send_messages;
		const isMuted = status === 'restricted' && canSendMessages === false; // 被禁言
		const isBanned = status === 'kicked';                                // 被踢出/ban
		mutedOrBanned = isMuted || isBanned;
	} catch (error) {
		// 用户不在群里(getChatMember 返回 400 抛异常)或网络异常 → fail-open 放行,不阻断正常举报
		console.error('[/ad] 重复预检查询本群状态失败(按放行处理):', error.message);
		mutedOrBanned = false;
	}

	const blacklistCheck = await checkBlacklist(tgid, env);
	const localBlacklisted = Boolean(blacklistCheck.isBlacklisted);

	return {
		shouldSkip: mutedOrBanned && localBlacklisted,
		mutedOrBanned,
		localBlacklisted
	};
}

async function handleAdCommand(message, env, preAssessedThreat = null) {
	const chatId = message.chat.id;
	const userId = message.from.id;

	// 1. 必须在 GROUP_ID 群内
	if (chatId.toString() !== GROUP_ID.toString()) {
		return;
	}

	// 权限已在外层 handleMessage 中校验(管理员或助推者),此处不重复检查

	// 2. 解析目标用户
	const adCommand = parseAdCommand(message.text);
	let targetUserId = '';
	let targetUserSnapshot = null;
	const repliedUser = message.reply_to_message?.from;
	if (repliedUser && repliedUser.id !== undefined && repliedUser.id !== null) {
		targetUserId = repliedUser.id.toString();
		targetUserSnapshot = snapshotTelegramUser(repliedUser);
	} else if (adCommand && adCommand.firstArg) {
		targetUserId = adCommand.firstArg;
		targetUserSnapshot = null;
	} else {
		// 管理员触发但参数错误,可以提示
		await sendTelegramMessage(
			chatId,
			'❌ 使用方法: 回复用户消息发送 <code>/ad</code>，或 <code>/ad &lt;用户ID&gt;</code>'
		);
		return;
	}

	if (!/^\d+$/.test(targetUserId)) {
		await sendTelegramMessage(chatId, '❌ 用户ID必须是数字');
		return;
	}

	// 统一补充目标用户资料(昵称/简介):getChatMember 拿 user(含昵称),
	// bio 在群内取不到时再用 getChat 兜底(仅当对方私聊过本机器人)。
	try {
		const statusResult = await checkUserStatus(targetUserId);
		// 管理员豁免:不能对 GROUP_ID 群管理员发起举报投票
		// (复用本次 getChatMember 的 status,零额外 API 调用;查询异常/不在群时 status 缺失 → 放行)
		const targetStatus = statusResult?.result?.status;
		if (targetStatus === 'administrator' || targetStatus === 'creator') {
			await sendTelegramMessage(chatId, `⚠️ 不能对群组管理员 <a href="tg://user?id=${targetUserId}">${targetUserId}</a> 发起举报投票`);
			return;
		}
		if (statusResult?.result?.user) {
			// 以 getChatMember 返回的 user 为准(可能比回复快照多 bio 等字段)
			targetUserSnapshot = snapshotTelegramUser(statusResult.result.user);
		}
	} catch (error) {
		console.log('[/ad] 查询目标用户资料失败(不影响主流程):', error.message);
	}
	if (targetUserSnapshot && !targetUserSnapshot.bio) {
		targetUserSnapshot.bio = (await fetchUserBio(targetUserId)) || '';
	}

	// 不能对自己发起
	if (targetUserId.toString() === userId.toString()) {
		await sendTelegramMessage(chatId, '⚠️ 不能对自己发起举报投票');
		return;
	}

	// 不能对机器人发起(回复场景通过 User 对象检测,直接传 tgid 场景无 User 对象,信任管理员判断)
	if (repliedUser?.is_bot || targetUserSnapshot?.isBot) {
		await sendTelegramMessage(chatId, '⚠️ 不能对机器人发起举报投票');
		return;
	}

	// 重复操作预检:目标用户在本群既已被禁言或被 ban、又已存在于本地黑名单时,跳过本次举报投票。
	const duplicateCheck = await checkAdDuplicate(targetUserId, env);
	console.log(`[/ad] 重复预检 tgid=${targetUserId} 已禁言或被ban=${duplicateCheck.mutedOrBanned} 本地黑名单=${duplicateCheck.localBlacklisted} 跳过=${duplicateCheck.shouldSkip}`);
	if (duplicateCheck.shouldSkip) {
		await sendTelegramMessage(chatId, `⚠️ <a href="tg://user?id=${targetUserId}">${targetUserId}</a> 已在本群被禁言或被封禁，且已在黑名单中，无需重复发起举报投票`);
		return;
	}

	const creatorUserSnapshot = snapshotTelegramUser(message.from);

	// 4. 被举报消息:仅回复场景记录预览,直接传 tgid 无回复时不显示
	const replyMsg = message.reply_to_message;
	const replyToMessageId = replyMsg?.message_id;
	let messagePreview = '';
	let reportContent = ''; // 发送给 AI 判断威胁评级的被举报消息内容
	if (replyMsg) {
		const src = (typeof replyMsg.text === 'string' && replyMsg.text.length > 0)
			? replyMsg.text
			: (typeof replyMsg.caption === 'string' && replyMsg.caption.length > 0 ? replyMsg.caption : '');
		messagePreview = src.slice(0, 50);
		reportContent = src.slice(0, AD_AI_MAX_CONTENT_CHARS);
	}

	// 被举报用户资料(昵称/用户名/简介):广告常把内容藏匿于其中,一并发给 AI 判断
	const profileText = buildUserProfileText(targetUserSnapshot);
	const aiContentParts = [];
	if (reportContent) {
		aiContentParts.push(`被举报消息内容:\n${reportContent}`);
	}
	if (profileText) {
		aiContentParts.push(`被举报用户资料:\n${profileText}`);
	}
	const aiContent = aiContentParts.join('\n\n');

	// 5. AI 威胁评级:有可判断内容(消息或用户资料)→ 调用 Workers AI 判断;
	//    完全无可判断内容(纯 tgid 且未取到资料)→ 回退 C 可疑(AD_VOTE_THRESHOLD 票);
	//    AI 基础设施失败(未绑定/超时/异常)→ 回退 🟡C 可疑 6 票;有响应但无法识别/拒绝答复 → 按 🟠B 危险 4 票;
	//    普通用户举报通道(preAssessedThreat 非空)→ 直接采用预评级,不再调用 AI
	let threatAssessment = null;
	if (!preAssessedThreat && aiContent) {
		threatAssessment = await assessThreatWithAI(env, aiContent, AD_GROUP_RULES);
	}
	let threat;
	if (preAssessedThreat) {
		// 普通用户举报通道预评级路径:直接采用,不再调用 AI
		threat = preAssessedThreat;
	} else if (threatAssessment?.ok) {
		threat = threatAssessment;
	} else if (threatAssessment?.code === 'unrecognized') {
		// AI 拒答或返回无法识别 → 视为 B 危险(内容可能确实违规才触发拒答)
		threat = {
			level: 'B',
			label: AD_THREAT_RATINGS.B.label,
			score: null,
			reason: 'AI 无法识别或拒绝答复，按 B 危险处理',
			threshold: AD_THREAT_RATINGS.B.votes
		};
	} else if (aiContent) {
		// 有可判断内容但 AI 基础设施失败(未绑定/超时/异常,assessThreatWithAI 返回 null)→ 回退 C 可疑
		threat = {
			level: 'C',
			label: AD_THREAT_RATINGS.C.label,
			score: null,
			reason: 'AI 调用失败，按 C 可疑处理',
			threshold: AD_THREAT_RATINGS.C.votes
		};
	} else {
		// 完全无可判断内容 → 中性 C 可疑
		threat = {
			level: 'C',
			label: AD_THREAT_RATINGS.C.label,
			score: null,
			reason: '无消息内容且未获取到用户资料，默认按 C 可疑处理',
			threshold: AD_VOTE_THRESHOLD
		};
	}

	// 最终评级决策日志:诊断哪条路径生效(预评级 / 无内容 / AI成功 / AI拒答-unrecognized / AI异常-null)
	const path = preAssessedThreat
		? 'preassessed-user-report'
		: !aiContent
			? 'fallback-no-content'
			: threatAssessment?.ok
				? 'ai-success'
				: threatAssessment?.code === 'unrecognized'
					? 'ai-unrecognized→B'
					: 'ai-null→C';
	console.log('[ad-ai] === 最终评级决策 ===', JSON.stringify({
		path,
		level: threat.level,
		label: threat.label,
		score: threat.score,
		threshold: threat.threshold,
		reason: threat.reason
	}));

	const now = Math.floor(Date.now() / 1000);
	const voteToken = Math.random().toString(36).slice(2, 10); // 8字符随机 token

	// 6. 构造初始投票状态,发起人自动算 1 票赞成;阈值由 AI 威胁评级决定
	const state = {
		voteToken,
		messageId: null,
		reportedMessageId: replyToMessageId || null, // 回复场景:被举报消息ID,通过后删除
		chatId: chatId.toString(),
		targetUserId,
		creatorUserId: userId.toString(),
		targetUserSnapshot,
		creatorUserSnapshot,
		messagePreview,
		approvers: creatorUserSnapshot ? [creatorUserSnapshot] : [],
		rejecters: [],
		threshold: threat.threshold,
		rejectThreshold: Math.max(1, AD_VOTE_MAX_VOTES - threat.threshold), // 反对阈值 = 10 - 赞成阈值
		threatLevel: threat.level,
		threatLabel: threat.label,
		threatScore: threat.score,
		threatReason: threat.reason,
		createdAt: now,
		deadlineAt: now + AD_VOTE_DURATION_HOURS * 3600,
		finalized: false,
		result: null
	};

	const initialText = buildAdVoteMessageText(state);

	// 先用 token 存 KV(确保按钮点击时 state 已存在),再发消息
	await saveAdVoteState(env, state);

	const initialMarkup = buildAdVoteInlineKeyboard(voteToken, state);
	const sentMessage = await sendTelegramMessage(chatId, initialText, initialMarkup, replyToMessageId);
	if (!sentMessage || !sentMessage.ok || !sentMessage.result?.message_id) {
		console.error('[/ad] 发送投票消息失败:', JSON.stringify(sentMessage));
		return;
	}

	// 回填 messageId,用于后续 editMessageText
	state.messageId = sentMessage.result.message_id;
	await saveAdVoteState(env, state);
}

async function handleAdCallbackQuery(callbackQuery, env) {
	const data = callbackQuery.data || '';
	if (!data.startsWith(AD_VOTE_BUTTON_PREFIX)) {
		return;
	}

	const voterId = callbackQuery.from.id;
	const chatId = callbackQuery.message?.chat?.id;

	if (!chatId) {
		return;
	}

	// 群外投票直接忽略(按钮只能在消息所在群里点)
	if (chatId.toString() !== GROUP_ID.toString()) {
		return;
	}

	// 任何群成员都可以投票(只校验在 GROUP_ID 群内,已在上方检查)

	// 解析 callback_data: adv:A:<voteToken> 或 adv:R:<voteToken>
	const tail = data.slice(AD_VOTE_BUTTON_PREFIX.length);
	const parts = tail.split(':');
	if (parts.length < 2) {
		try { await answerCallbackQuery(callbackQuery.id); } catch (_) { }
		return;
	}
	const action = parts[0];
	const voteToken = parts.slice(1).join(':'); // token 可能含额外冒号,防御性拼接
	if (action !== 'A' && action !== 'R') {
		try { await answerCallbackQuery(callbackQuery.id); } catch (_) { }
		return;
	}
	if (!voteToken || voteToken.length < 2) {
		try { await answerCallbackQuery(callbackQuery.id); } catch (_) { }
		return;
	}

	const state = await getAdVoteState(env, voteToken);
	if (!state) {
		try {
			await answerCallbackQuery(callbackQuery.id, '投票不存在或已过期', true);
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (无投票状态) 失败:', error.message);
		}
		return;
	}

	const messageId = state.messageId;
	if (!messageId || messageId <= 0) {
		// messageId 尚未回填(极端竞态:点击发生在回填前),静默应答稍后重试
		try { await answerCallbackQuery(callbackQuery.id); } catch (_) { }
		return;
	}

	if (state.finalized) {
		// 自我修复:state.finalized=true 但消息可能因 finalize 时 editMessageText 失败
		// (网络抖动 / TG API 临时错误) 而未更新;这里用最新 state 强制重编一次,
		// 移除按钮 + 刷新为"已结束"文本,保证 UI 与实际状态最终一致
		try {
			const finalText = buildAdVoteMessageText(state);
			const removeButtonsMarkup = { inline_keyboard: [] };
			await editMessageText(chatId, messageId, finalText, removeButtonsMarkup);
			console.log(`[/ad] 自我修复: 强制刷新已结束消息 messageId=${messageId}`);
		} catch (refetchErr) {
			console.error('[/ad] 自我刷新已结束消息失败:', refetchErr.message);
		}
		try {
			await answerCallbackQuery(callbackQuery.id, '投票已结束', true);
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (已结束) 失败:', error.message);
		}
		return;
	}

	// 投票资格检查:仅"被禁言"或"不在群里"的用户不允许投票
	let voterStatus = null;
	let voterStatusError = null;
	try {
		voterStatus = await checkUserStatus(voterId);
	} catch (error) {
		// getChatMember 对不在群里的用户(从未入群/被移除/主动退群)会返回 400,
		// 这里把异常也视为"不在群里",拒绝投票(而不是放行)
		voterStatusError = error;
	}

	const voterStatusValue = voterStatus?.result?.status;
	// can_send_messages 为 getChatMember 返回的直挂属性(result.can_send_messages):
	// true 表示能发消息(未被禁言), false 才是真禁言;
	// undefined 会出现在 kicked/left 等状态,按"不在群里"处理而非误判为禁言
	const canSendMessages = voterStatus?.result?.can_send_messages;
	if (voterStatusError || !voterStatus?.ok || !voterStatusValue) {
		// 状态获取失败或状态缺失,一律视为"不在群里",拒绝投票
		if (voterStatusError) {
			console.error('[/ad] 检查投票资格失败:', voterStatusError.message);
		}
		try {
			await answerCallbackQuery(callbackQuery.id, '你不在群里，无法投票', true);
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (资格检查失败) 失败:', error.message);
		}
		return;
	}

	// 详细日志:打印 status 与 can_send_messages,方便后续排查资格判断问题
	console.log(`[/ad] 投票资格检查 voterId=${voterId} status=${voterStatusValue} can_send_messages=${canSendMessages}`);

	if (voterStatusValue === 'restricted') {
		// restricted 不等于禁言:只有当 can_send_messages === false 才是真禁言;
		// 受限但仍能发消息(如仅被禁发图片/链接)时允许投票
		if (canSendMessages === false) {
			try {
				await answerCallbackQuery(callbackQuery.id, '你已被禁言，无法投票', true);
			} catch (error) {
				console.error('[/ad] answerCallbackQuery (禁言) 失败:', error.message);
			}
			return;
		}
		// can_send_messages === true 或 undefined 均放行
	}
	if (voterStatusValue === 'kicked' || voterStatusValue === 'left') {
		// 被踢出群 / 主动退群:不在群里,拒绝投票
		try {
			await answerCallbackQuery(callbackQuery.id, '你不在群里，无法投票', true);
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (不在群里) 失败:', error.message);
		}
		return;
	}
	// 其余状态(member / administrator / creator)以及"受限但能发消息"的 restricted 允许投票

	// 发起人放弃举报:发起人自己点"反对"视为放弃举报,立即关闭投票
	// (即使发起人同时是管理员也优先走放弃语义,因为该分支位于管理员否决之前)
	if (action === 'R' && voterId.toString() === state.creatorUserId.toString()) {
		// 把发起人从赞成/反对名单中都移除:放弃后其默认的 1 票赞成不再显示/计数
		state.approvers = state.approvers.filter((v) => v.id.toString() !== voterId.toString());
		state.rejecters = state.rejecters.filter((v) => v.id.toString() !== voterId.toString());
		state.withdrawnBy = snapshotTelegramUser(callbackQuery.from);
		console.log(`[/ad] 发起人 ${voterId} 放弃举报,投票关闭`);
		await finalizeAdVote(env, state, chatId, messageId, 'cancelled');
		try {
			await answerCallbackQuery(callbackQuery.id, '你已放弃举报，投票已关闭');
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (发起人放弃) 失败:', error.message);
		}
		return;
	}

	// 群管理员一票否决:管理员点"赞成"或"反对"立即结束
	const voterIsAdmin = await checkIfUserIsAdmin(voterId);
	if (voterIsAdmin) {
		const adminResult = action === 'A' ? 'approved' : 'rejected';
		state.vetoedBy = snapshotTelegramUser(callbackQuery.from);
		console.log(`[/ad] 管理员 ${voterId} 行使一票否决: ${adminResult}`);
		await finalizeAdVote(env, state, chatId, messageId, adminResult);
		try {
			await answerCallbackQuery(callbackQuery.id, action === 'A' ? '管理员赞成，一票通过' : '管理员反对，一票否决');
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (管理员否决) 失败:', error.message);
		}
		return;
	}

	// 更新投票人列表(去重 + 支持改投)
	const voterSnapshot = snapshotTelegramUser(callbackQuery.from);
	state.approvers = state.approvers.filter((v) => v.id.toString() !== voterId.toString());
	state.rejecters = state.rejecters.filter((v) => v.id.toString() !== voterId.toString());

	if (action === 'A' && voterSnapshot) {
		state.approvers.push(voterSnapshot);
	} else if (action === 'R' && voterSnapshot) {
		state.rejecters.push(voterSnapshot);
	}

	// 判定阈值:赞成达阈值即通过;反对达反对阈值(12-赞成阈值)即否决。
	// 兼容旧 KV 状态:无 rejectThreshold 字段时回退为赞成阈值(旧行为)。
	const rejectThreshold = state.rejectThreshold || state.threshold;
	if (state.approvers.length >= state.threshold) {
		await finalizeAdVote(env, state, chatId, messageId, 'approved');
		// 已结束:弹窗提示投票人本次投票生效
		try {
			await answerCallbackQuery(callbackQuery.id, '投票已通过');
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (已通过) 失败:', error.message);
		}
		return;
	}
	if (state.rejecters.length >= rejectThreshold) {
		await finalizeAdVote(env, state, chatId, messageId, 'rejected');
		try {
			await answerCallbackQuery(callbackQuery.id, '投票已被否决');
		} catch (error) {
			console.error('[/ad] answerCallbackQuery (已被否决) 失败:', error.message);
		}
		return;
	}

	// 未结束:刷新消息文本 + 按钮
	await saveAdVoteState(env, state);
	const newText = buildAdVoteMessageText(state);
	const newMarkup = buildAdVoteInlineKeyboard(state.voteToken, state);
	await editMessageText(chatId, messageId, newText, newMarkup);

	// 静默应答,清除按钮的 loading 状态
	try {
		await answerCallbackQuery(callbackQuery.id);
	} catch (error) {
		console.error('[/ad] answerCallbackQuery (成功) 失败:', error.message);
	}
}

async function finalizeAdVote(env, state, chatId, messageId, result) {
	state.finalized = true;
	state.result = result;

	await saveAdVoteState(env, state);

	const finalText = buildAdVoteMessageText(state);

	// 先移除按钮,再异步执行封禁动作(失败不影响投票结论)
	const removeButtonsMarkup = { inline_keyboard: [] };
	try {
		await editMessageText(chatId, messageId, finalText, removeButtonsMarkup);
	} catch (editErr) {
		console.error('[/ad] finalize 阶段更新消息失败(将由 callback 自我修复兜底):', editErr.message);
	}

	if (result === 'approved') {
		try {
			await addToBlacklist(state.targetUserId, env, 'ad', state.creatorUserId);
			console.log(`[/ad] 已将用户 ${state.targetUserId} 加入黑名单`);
		} catch (error) {
			console.error('[/ad] finalize 写入黑名单失败:', error.message);
		}		// 检查用户群内状态:
		// - 在群(member/administrator/creator/restricted)→ 禁言;
		// - 不在群(left/kicked/状态缺失/查询异常/从未入群)→ 永久封禁为主动作。
		// 注意:用户从未入群时,Telegram 对 getChatMember / banChatMember 都会返回 400
		// (USER_NOT_PARTICIPANT),此时无法通过 API 封禁,绝不回退到禁言,仅依赖已写入的
		// 本地黑名单,待其入群时由 handleNewChatMemberBots 入群拦截逻辑处理。
		let userStatus = null;
		try {
			const statusResult = await checkUserStatus(state.targetUserId);
			userStatus = statusResult?.result?.status || null;
		} catch (error) {
			// 状态查询异常(如从未入群返回 400 USER_NOT_PARTICIPANT)→ 视为不在群,走永久封禁分支
			console.error('[/ad] 查询用户状态失败(视为不在群),执行永久封禁:', error.message);
		}

		const inGroup = userStatus === 'member' || userStatus === 'restricted' || userStatus === 'administrator' || userStatus === 'creator';
		if (inGroup) {
			// 在群(含 restricted 被禁言状态)→ 禁言,不封禁
			try {
				await muteChatMember(chatId, state.targetUserId);
				console.log(`[/ad] 用户 ${state.targetUserId} 在群(${userStatus}),已在群 ${chatId} 内禁言`);
				// 禁言成功 → 标记该用户在本群状态为"禁言"
				await markUserGroupStatus(env, state.targetUserId, GROUP_MEMBER_STATUS.MUTED);
			} catch (muteError) {
				console.error('[/ad] finalize 禁言失败:', muteError.message);
			}
		} else {
			// 不在群:永久封禁为主动作
			try {
				await banUserPermanently(chatId, state.targetUserId);
				console.log(`[/ad] 用户 ${state.targetUserId} 不在群内(${userStatus || '状态缺失/查询异常'}),已永久封禁`);
				// 封禁成功 → 标记该用户在本群状态为"封禁"
				await markUserGroupStatus(env, state.targetUserId, GROUP_MEMBER_STATUS.BANNED);
			} catch (banError) {
				// 用户从未入群等场景,banChatMember 同样返回 400:不回退到禁言,
				// 黑名单已写入,待用户入群时由入群拦截逻辑封禁
				console.error('[/ad] finalize 永久封禁失败(用户不在群无法通过 API 封禁),已记入本地黑名单,待其入群时由入群拦截逻辑处理:', banError.message);
			}
		}
		// 回复场景:删除被举报的广告消息
		if (state.reportedMessageId) {
			try {
				await deleteMessage(chatId, state.reportedMessageId);
			} catch (error) {
				console.error('[/ad] finalize 删除被举报消息失败:', error.message);
			}
		}
	} else {
		console.log(`[/ad] 投票 ${messageId} 已结束(result=${result}),目标用户 ${state.targetUserId} 不处理`);
	}
}

// ========================================================
// 联网黑名单自动查杀(非 GROUP_ID 群, bot 为群管理员时启用)
// ========================================================
// 概要:
// - 触发条件:事件发生在非 GROUP_ID 的群聊,且 bot 仍是该群管理员(administrator/creator;
//   administrator 还需具备 can_restrict_members 权限,否则禁言/封禁无法执行,模式视为不可用)。
// - 触发事件:① 新成员入群(new_chat_members) ② 真人发送消息(消息路径)。
// - 新 TGID(users 表无记录):自动建档,active_group_ids 记录本群 + 状态"健康",放行
//   (新用户不可能在 CM 黑名单)。
// - 存量 TGID:本群状态为"健康"且 is_blacklisted=1(CM 黑名单)→ 禁言 + 本群状态同步"禁言" +
//   群内通知,通知附带"永久封禁 / 加入白名单"按钮(仅本群管理员可点)。
// - 按钮"永久封禁"→ banChatMember 踢出 + 本群状态"封禁";"加入白名单"→ unban + 恢复发言 +
//   状态"白名单"(白名单为本群豁免,不再触发查杀)。
// - 非 GROUP_ID 群内的 /ban /spam /unban 仅维护本群状态,绝不修改 is_blacklisted;
//   is_blacklisted 只代表"CM 黑名单"(GROUP_ID 群黑名单),只能由 GROUP_ID 群内的
//   /ad /ban /spam /unban 修改。
const NETKILL_BUTTON_PREFIX = 'cmk:';

const NETKILL_LOG_LABELS = {
	'trigger:skip-group-id': '跳过:消息来自 GROUP_ID 主群,不启用联网查杀',
	'trigger:skip-not-group-chat': '跳过:非群聊(私聊/频道),不启用联网查杀',
	'trigger:skip-no-db': '跳过:未绑定 D1,无法维护 active_group_ids 群组状态',
	'trigger:skip-bot-not-admin': '跳过:bot 不是当前群管理员(或缺少限制成员权限),联网查杀模式未启用',
	'new-user:record-created': '新 TGID:已在数据库建档(本群状态=健康)',
	'status:skip': '跳过:该用户在本群已有状态(禁言/封禁/白名单/管理员),已处理或豁免,不重复查杀',
	'blacklist:miss': '跳过:本群状态健康,但用户不在 CM 黑名单',
	'action:mute:start': '开始:命中 CM 黑名单,执行禁言',
	'action:mute:success': '成功:已禁言并同步本群状态为"禁言"',
	'action:mute:failed': '失败:禁言失败(不写状态、不通知)',
	'status:admin-detected': '检测:目标用户实为本群管理员,禁言被 TG API 拒绝,记录状态"管理员"避免重复尝试',
	'notify:sent': '已发送 CM 黑名单通知与管理员操作按钮',
	'callback:ban:start': '按钮:本群管理员点击"永久封禁"',
	'callback:ban:success': '按钮:已永久封禁并同步本群状态"封禁"',
	'callback:ban:failed': '按钮:永久封禁失败',
	'callback:wl:start': '按钮:本群管理员点击"加入白名单"',
	'callback:wl:success': '按钮:已加入本群白名单并解除封禁/禁言',
	'callback:wl:failed': '按钮:白名单操作失败'
};

function logNetKill(step, details = {}) {
	const label = NETKILL_LOG_LABELS[step] || step;
	try {
		console.log(`[联网查杀] ${label}: ${JSON.stringify(details)}`);
	} catch (error) {
		console.log(`[联网查杀] ${label}: 日志详情序列化失败：${error.message}`);
	}
}

// getChatMember 原始结果(任意用户/任意群);失败或用户不在群返回 null
async function getChatMemberInfo(chatId, userId) {
	try {
		const url = `https://api.telegram.org/bot${BOT_TOKEN}/getChatMember`;
		const body = { chat_id: chatId, user_id: userId };
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		const result = await response.json();
		if (!response.ok || !result.ok || !result.result) return null;
		return result.result;
	} catch (error) {
		console.error('获取群成员信息失败:', error.message);
		return null;
	}
}

// 任意用户在任意群是否管理员(creator/administrator)
async function checkIfUserIsAdminInChat(userId, chatId) {
	const info = await getChatMemberInfo(chatId, userId);
	return info ? (info.status === 'creator' || info.status === 'administrator') : false;
}

// bot 是否当前群管理员(按群缓存 60s):
// - creator(群主)→ 是;
// - administrator → 要求 can_restrict_members !== false(无"限制成员"权限则无法执行
//   禁言/封禁,视为模式不可用,避免每次消息都产生无效的 restrictChatMember 调用);
// - 其余(member/left/restricted 等)→ 否。
const BOT_CHAT_ADMIN_CACHE_TTL_MS = 60000;
const botChatAdminCache = new Map();
async function checkIfBotIsAdminInChat(chatId) {
	const key = String(chatId);
	const now = Date.now();
	const cached = botChatAdminCache.get(key);
	if (cached && (now - cached.fetchedAt) < BOT_CHAT_ADMIN_CACHE_TTL_MS) {
		return cached.isAdmin;
	}
	const botId = await getBotId();
	if (!botId) return false;
	const info = await getChatMemberInfo(chatId, botId);
	let isAdmin = false;
	if (info?.status === 'creator') {
		isAdmin = true;
	} else if (info?.status === 'administrator') {
		isAdmin = info.can_restrict_members !== false;
	}
	botChatAdminCache.set(key, { isAdmin, fetchedAt: now });
	return isAdmin;
}

// 解除指定群封禁(unbanChatMember,only_if_banned 幂等:未封禁时为成功空操作)
async function unbanUserInChat(chatId, userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`;
	const body = {
		chat_id: chatId,
		user_id: userId,
		only_if_banned: true
	};
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const result = await response.json();
	if (!response.ok || !result.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}
	console.log(`执行 unbanUserInChat，chat=${chatId} user=${userId}, 响应: ${JSON.stringify(result)}`);
	return result;
}

// 恢复指定群发言权限(restrictChatMember 全权限放开)
async function restrictUserInChat(chatId, userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/restrictChatMember`;
	const body = {
		chat_id: chatId,
		user_id: userId,
		use_independent_chat_permissions: true,
		permissions: {
			can_send_messages: true,
			can_send_audios: true,
			can_send_documents: true,
			can_send_photos: true,
			can_send_videos: true,
			can_send_video_notes: true,
			can_send_voice_notes: true,
			can_send_polls: true,
			can_send_other_messages: true,
			can_add_web_page_previews: true,
			can_change_info: false,
			can_invite_users: true,
			can_pin_messages: false
		}
	};
	const response = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	const result = await response.json();
	if (!response.ok || !result.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}
	console.log(`执行 restrictUserInChat，chat=${chatId} user=${userId}, 响应: ${JSON.stringify(result)}`);
	return result;
}

// 构建联网查杀通知文案 + 操作按钮(仅本群管理员可点,业务侧校验)
function buildNetKillNotification(tgid, member) {
	const mention = formatUserMention(member)
		|| `<a href="tg://user?id=${escapeHtml(tgid)}">${escapeHtml(tgid)}</a>`;
	const text = `⚠️ <b>CM 黑名单用户检测</b>

🚫 该用户存在于 <b>CM 黑名单</b> 中，已在本群禁言处理。

👤 用户: ${mention}
📋 TGID: <code>${escapeHtml(tgid)}</code>

👇 仅限本群管理员操作：`;
	const replyMarkup = {
		inline_keyboard: [[
			{ text: '🔨 永久封禁', callback_data: `${NETKILL_BUTTON_PREFIX}ban:${tgid}` },
			{ text: '✅ 加入白名单', callback_data: `${NETKILL_BUTTON_PREFIX}wl:${tgid}` }
		]]
	};
	return { text, replyMarkup };
}

// 联网黑名单自动查杀主逻辑:
// members 为待检查的 user 对象数组(入群事件取 new_chat_members,普通消息取 [message.from])。
// 仅在非 GROUP_ID 群 + bot 为该群管理员时生效;依赖 D1(active_group_ids / is_blacklisted)。
async function handleNetworkBlacklistKill(chat, members, env) {
	if (!chat || !Array.isArray(members) || members.length === 0) return;
	const chatId = chat.id;
	if (chatId === undefined || chatId === null) return;
	if (chatId.toString() === GROUP_ID.toString()) {
		logNetKill('trigger:skip-group-id', { chatId: chatId.toString() });
		return;
	}
	if (chat.type !== 'group' && chat.type !== 'supergroup') {
		logNetKill('trigger:skip-not-group-chat', { chatId: chatId.toString(), type: chat.type });
		return;
	}
	if (!isDbReady(env)) {
		logNetKill('trigger:skip-no-db', { chatId: chatId.toString() });
		return;
	}

	// 触发条件:bot 必须是当前群管理员(且有限制成员权限)
	const botIsAdmin = await checkIfBotIsAdminInChat(chatId);
	if (!botIsAdmin) {
		logNetKill('trigger:skip-bot-not-admin', { chatId: chatId.toString() });
		return;
	}

	for (const member of members) {
		if (!member || member.id === undefined || member.id === null) continue;
		if (member.is_bot) continue; // 只处理真人 TGID
		const tgid = String(member.id);
		const row = await dbGetUserKillInfo(env, tgid);
		const decision = decideNetKillAction(row, chatId);

		if (decision.action === 'record') {
			// 新 TGID:建档(本群状态=健康),新用户不可能在黑名单,直接放行
			await dbSetUserGroupStatus(env, tgid, chatId, GROUP_MEMBER_STATUS.HEALTHY);
			logNetKill('new-user:record-created', { tgid, chatId: chatId.toString() });
			continue;
		}
		if (decision.action === 'skip') {
			logNetKill(decision.reason === 'not-blacklisted' ? 'blacklist:miss' : 'status:skip',
				{ tgid, chatId: chatId.toString(), ...decision });
			continue;
		}

		// action === 'mute':命中 CM 黑名单 → 禁言 + 本群状态同步"禁言" + 通知按钮
		logNetKill('action:mute:start', { tgid, chatId: chatId.toString() });
		try {
			await muteChatMember(chatId, member.id);
			await dbSetUserGroupStatus(env, tgid, chatId, GROUP_MEMBER_STATUS.MUTED);
			logNetKill('action:mute:success', { tgid, chatId: chatId.toString() });
			const notification = buildNetKillNotification(tgid, member);
			await sendTelegramMessage(chatId, notification.text, notification.replyMarkup);
			logNetKill('notify:sent', { tgid, chatId: chatId.toString() });
		} catch (error) {
			const errMsg = String(error?.message || '');
			// 目标实为本群管理员/群主时 TG API 拒绝 restrict → 记录"管理员"避免每条消息重复尝试
			if (/administrator|chat creator|creator of the chat/i.test(errMsg)) {
				await dbSetUserGroupStatus(env, tgid, chatId, GROUP_MEMBER_STATUS.ADMIN);
				logNetKill('status:admin-detected', { tgid, chatId: chatId.toString() });
			}
			logNetKill('action:mute:failed', { tgid, chatId: chatId.toString(), 错误: errMsg });
		}
	}
}

// 处理联网查杀通知的按钮回调("永久封禁" / "加入白名单")。
// 返回 true 表示已消费该回调(无论成败),false 表示不是本功能回调(交由 /ad 投票处理)。
async function handleNetworkKillCallbackQuery(callbackQuery, env) {
	const data = callbackQuery.data || '';
	if (!data.startsWith(NETKILL_BUTTON_PREFIX)) return false;

	const message = callbackQuery.message;
	const chatId = message?.chat?.id;
	if (!chatId) {
		try { await answerCallbackQuery(callbackQuery.id); } catch (_) { }
		return true;
	}
	if (chatId.toString() === GROUP_ID.toString()) {
		// 防御:该按钮只应出现在非 GROUP_ID 群的通知里
		try { await answerCallbackQuery(callbackQuery.id, '无效操作', true); } catch (_) { }
		return true;
	}

	const parts = data.split(':');
	const action = parts[1];
	const tgid = parts.slice(2).join(':');
	if ((action !== 'ban' && action !== 'wl') || !/^\d+$/.test(tgid)) {
		try { await answerCallbackQuery(callbackQuery.id, '无效操作', true); } catch (_) { }
		return true;
	}

	const operatorId = callbackQuery.from.id;
	// 按钮仅允许当前群管理员点击
	const isAdmin = await checkIfUserIsAdminInChat(operatorId, chatId);
	if (!isAdmin) {
		try { await answerCallbackQuery(callbackQuery.id, '仅限本群管理员操作', true); } catch (_) { }
		return true;
	}

	const messageId = message.message_id;
	const removeButtons = { inline_keyboard: [] };
	const mention = `<a href="tg://user?id=${escapeHtml(tgid)}">${escapeHtml(tgid)}</a>`;

	if (action === 'ban') {
		logNetKill('callback:ban:start', { tgid, chatId: chatId.toString(), operatorId });
		try {
			await banUserPermanently(chatId, tgid);
			await dbSetUserGroupStatus(env, tgid, chatId, GROUP_MEMBER_STATUS.BANNED);
			await editMessageText(chatId, messageId,
				`🔨 <b>已永久封禁</b>\n\n${mention} 已移出本群。\n📌 本群状态: 封禁`, removeButtons);
			logNetKill('callback:ban:success', { tgid, chatId: chatId.toString(), operatorId });
			try { await answerCallbackQuery(callbackQuery.id, '已永久封禁该用户'); } catch (_) { }
		} catch (error) {
			logNetKill('callback:ban:failed', { tgid, chatId: chatId.toString(), 错误: error.message });
			try { await answerCallbackQuery(callbackQuery.id, `封禁失败: ${String(error.message).slice(0, 80)}`, true); } catch (_) { }
		}
		return true;
	}

	// action === 'wl':加入本群白名单 + 解除封禁/禁言
	logNetKill('callback:wl:start', { tgid, chatId: chatId.toString(), operatorId });
	try {
		await unbanUserInChat(chatId, tgid);
		try {
			await restrictUserInChat(chatId, tgid);
		} catch (restoreError) {
			// 用户已被踢出且未重新入群 → restrictChatMember 报 USER_NOT_PARTICIPANT,忽略:
			// 白名单状态已记录,待其重新入群时不会触发查杀
			console.log('[联网查杀] 恢复发言权限跳过(用户不在群内):', restoreError.message);
		}
		await dbSetUserGroupStatus(env, tgid, chatId, GROUP_MEMBER_STATUS.WHITELISTED);
		await editMessageText(chatId, messageId,
			`✅ <b>已加入本群白名单</b>\n\n${mention} 已解除封禁/禁言，后续不再自动查杀。\n📌 本群状态: 白名单`, removeButtons);
		logNetKill('callback:wl:success', { tgid, chatId: chatId.toString(), operatorId });
		try { await answerCallbackQuery(callbackQuery.id, '已加入白名单并解除限制'); } catch (_) { }
	} catch (error) {
		logNetKill('callback:wl:failed', { tgid, chatId: chatId.toString(), 错误: error.message });
		try { await answerCallbackQuery(callbackQuery.id, `操作失败: ${String(error.message).slice(0, 80)}`, true); } catch (_) { }
	}
	return true;
}

// ========================================================
// 业务层注入 DB 层管理员判定钩子
// ========================================================
// DB 层(黑名单豁免 / recordUserActivity 管理员状态标记)通过 setGroupAdminChecker 注册的
// 钩子判断"是否 GROUP_ID 群管理员",自身不直接调 Telegram API(保持 QA 沙箱可测)。
// 此处注入缓存版检查器(60s TTL),高频路径不吃 getChatMember 配额。
// 模块加载时仅注册钩子,不触发任何 API 调用;QA 沙箱切片不含此行,DB 层按无钩子(非管理员)处理。
setGroupAdminChecker(async (tgid) => checkIfUserIsAdminCached(tgid));
