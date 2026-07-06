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

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
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
					await handleMessage(update.message, env);
				} else {
					console.log('[Telegram更新] 跳过：update.message 为空，当前代码只处理普通消息。');
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
			allowed_updates: ['message']
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

// 检查用户是否在黑名单中
async function checkBlacklist(userId, env) {
	// 检查是否绑定了 KV 空间
	if (!env.KV) {
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
		// 如果出错，不阻止用户操作
		return { isBlacklisted: false, message: null };
	}
}

// 添加用户到黑名单
async function addToBlacklist(userId, env) {
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

		return { success: true, message: `✅ 已将用户 <code>${userId}</code> 添加到黑名单` };
	} catch (error) {
		console.error('添加黑名单时出错:', error);
		return { success: false, message: '❌ 添加黑名单失败: ' + error.message };
	}
}

// 从黑名单中移除用户
async function removeFromBlacklist(userId, env) {
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

	if (!isManagedGroupMessage(message)) {
		return '';
	}

	const repliedUserId = message.reply_to_message?.from?.id;
	return repliedUserId ? repliedUserId.toString() : '';
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

async function restoreUserInManagedGroup(userId) {
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
		} catch (error) {
			console.error('群内解除封禁失败:', error);
			failures.push(`解除封禁失败: ${escapeHtml(error.message)}`);
		}
	}

	if (status === 'restricted' && isMember !== false) {
		try {
			await restrictUser(userId);
			actions.push(`已恢复发言权限`);
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
		} catch (error) {
			console.error('群内解除封禁失败:', error);
			failures.push(`解除封禁失败: ${escapeHtml(error.message)}`);
		}
	}

	if (!status) {
		try {
			await restrictUser(userId);
			actions.push(`已尝试恢复发言权限`);
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
		banlistData = { success: false, error: error.message };
	}

	// 2. 查询本地 KV
	let isLocalBlacklisted = false;
	if (options.env) {
		const blacklistCheck = await checkBlacklist(tgidToCheck, options.env);
		isLocalBlacklisted = blacklistCheck.isBlacklisted;
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

	// 本地 KV 状态
	if (options.env) {
		if (isLocalBlacklisted) {
			responseMessage += `💾 <b>本地黑名单:</b> 🚫 <b>已封禁</b>\n`;
		} else {
			responseMessage += `💾 <b>本地黑名单:</b> ✅ 正常\n`;
		}
	} else {
		responseMessage += `💾 <b>本地黑名单:</b> ⚠️ 未检查 (未配置KV空间)\n`;
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
	'skip:new-member-not-bot': '跳过：新成员不是机器人',
	'skip:new-member-self': '跳过：新成员是当前机器人自己',
	'new-member-admin-status': '已查询新入群机器人在群里的身份',
	'skip:new-member-admin-status-check-failed': '跳过：无法确认新入群机器人是否为管理员，为避免误伤不处理',
	'skip:new-member-admin-bot': '跳过：新入群机器人是群管理员',
	'action:mute-new-bot:start': '开始处理：禁言新入群的非管理员机器人',
	'action:mute-new-bot:success': '处理成功：已禁言新入群的非管理员机器人',
	'action:mute-new-bot:failed': '处理失败：禁言新入群机器人失败',
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

async function handleNewChatMemberBots(message) {
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
			logBotModeration('skip:new-member-not-bot', logInfo);
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
	if (await handleNewChatMemberBots(message)) {
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

	// 处理 GROUP_ID 群组内管理员回复 /spam - 添加被回复用户到黑名单
	if (isSpamCommand(text)) {
		if (chatId.toString() !== GROUP_ID.toString()) {
			return;
		}

		const isAdmin = await checkIfUserIsAdmin(userId);
		if (!isAdmin) {
			return;
		}

		const repliedUserId = message.reply_to_message?.from?.id;
		if (!repliedUserId) {
			await sendTelegramMessage(chatId, '❌ 请回复要加入黑名单的用户消息后再发送 <code>/spam</code>');
			return;
		}

		const result = await addToBlacklist(repliedUserId, env);
		const linkedUserId = `<a href="tg://user?id=${repliedUserId}">${repliedUserId}</a>`;

		if (result.success) {
			await sendTelegramMessage(chatId, `✅ 已将用户 ${linkedUserId} 添加到黑名单`);
		} else {
			await sendTelegramMessage(chatId, `${result.message}\nTG ID: ${linkedUserId}`);
		}
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
	// 处理 /ban 命令 - 添加用户到黑名单
	if (banCommand) {
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
		const result = await addToBlacklist(targetUserId, env);
		let responseMessage = result.message;

		if (isManagedGroupMessage(message) && (result.success || result.alreadyExists)) {
			try {
				await muteChatMember(chatId, targetUserId);
				responseMessage += `\n✅ 已在群内禁言用户 <a href="tg://user?id=${targetUserId}">${targetUserId}</a>`;
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
	// 处理 /unban 命令 - 从黑名单移除或显示欢迎消息
	if (unbanCommand) {
		const targetUserId = getCommandTargetUserId(unbanCommand, message);
		const shouldHandleAdminUnban = Boolean(targetUserId) || isManagedGroupMessage(message);

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
			const result = await removeFromBlacklist(targetUserId, env);
			let responseMessage = result.message;

			if (result.success || result.notFound) {
				const restoreResult = await restoreUserInManagedGroup(targetUserId);
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
				//await sendTelegramMessage(GROUP_ID, `${userId} 已通过自助解封`);
			} else if (userStatus === 'restricted') {
				// 用户被禁言，需要解除禁言
				await restrictUser(userId);
				await sendTelegramMessage(chatId, '✅ 您的禁言已解除，可以正常发言了。');
			} else if (userStatus === 'left' || userStatus === 'member') {
				// 用户已离开群组或已是成员，检查权限
				if (userPermissions.can_send_messages === false) {
					// 用户有发言限制，解除限制
					await restrictUser(userId);
					await sendTelegramMessage(chatId, '✅ 您的发言限制已解除，可以正常发言了。');
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
				await sendTelegramMessage(GROUP_ID, `用户 ${userId} 已通过自助解禁`);
			} catch (restrictError) {
				console.error('解除禁言失败:', restrictError);
				try {
					await unbanUser(userId);
					await sendTelegramMessage(chatId, '✅ 您已被解封，可以重新加入群组。如果仍然无法发言，请联系管理员。');
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
async function sendTelegramMessage(chatId, text, replyMarkup) {
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
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/unbanChatMember`;
	const body = {
		chat_id: GROUP_ID,
		user_id: userId,
		only_if_banned: true
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

	// 添加调试日志
	console.log(`执行 unbanUser，状态: ${response.status}, 响应: ${JSON.stringify(result)}`);

	return result;
}

// 解除用户禁言（恢复发言权限）
async function restrictUser(userId) {
	const url = `https://api.telegram.org/bot${BOT_TOKEN}/restrictChatMember`;
	const body = {
		chat_id: GROUP_ID,
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

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}, body: ${JSON.stringify(result)}`);
	}

	// 添加调试日志
	console.log(`执行 restrictUser，状态: ${response.status}, 响应: ${JSON.stringify(result)}`);

	return result;
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
