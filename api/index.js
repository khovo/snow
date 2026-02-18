const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// ============================================================
// 1. CONFIGURATION
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// ============================================================
// 2. DATABASE SCHEMAS
// ============================================================

const processedUpdateSchema = new mongoose.Schema({
  update_id: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});
const ProcessedUpdate = mongoose.models.ProcessedUpdate || mongoose.model('ProcessedUpdate', processedUpdateSchema);

const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ date: { type: Date, default: Date.now }, reason: String }],
  lastActive: { type: Date, default: Date.now },
  lastMenuId: { type: Number },
  nickname: { type: String, default: "Anonymous" },
  bio: { type: String, default: "" },
  emoji: { type: String, default: "👤" },
  aura: { type: Number, default: 0 },
  isBanned: { type: Boolean, default: false },
  adminState: { step: { type: String, default: null }, tempData: { type: mongoose.Schema.Types.Mixed, default: {} } }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String },
  inlineLinks: [{ label: String, url: String }] 
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

const postSchema = new mongoose.Schema({
    confessionId: Number,
    userId: String,
    authorName: String,
    text: String,
    status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
    upvotes: [String],
    downvotes: [String],
    createdAt: { type: Date, default: Date.now }
});
postSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 }); 
const Post = mongoose.models.Post || mongoose.model('Post', postSchema);

const commentSchema = new mongoose.Schema({
    postId: mongoose.Schema.Types.ObjectId,
    userId: String,
    authorName: String,
    text: String,
    upvotes: [String],
    downvotes: [String],
    replies: [{ authorName: String, text: String }],
    createdAt: { type: Date, default: Date.now }
});
commentSchema.index({ createdAt: 1 }, { expireAfterSeconds: 604800 });
const Comment = mongoose.models.Comment || mongoose.model('Comment', commentSchema);

// ============================================================
// 3. DB CONNECTION
// ============================================================
let cachedDb = null;
async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  try {
    cachedDb = await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 });
    return cachedDb;
  } catch (error) { throw error; }
}

// ============================================================
// 4. HELPER FUNCTIONS
// ============================================================
async function setAdminStep(userId, step, data = {}) { await User.findOneAndUpdate({ userId }, { adminState: { step, tempData: data } }, { upsert: true }); }
async function getAdminState(userId) { const user = await User.findOne({ userId }); return user ? user.adminState : { step: null, tempData: {} }; }
async function clearAdminStep(userId) { await User.findOneAndUpdate({ userId }, { adminState: { step: null, tempData: {} } }); }
async function getConfig(key, def) { const doc = await Config.findOne({ key }); return doc ? doc.value : def; }

function escapeMarkdown(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function getNextConfessionId() {
    const last = await Post.findOne().sort({ confessionId: -1 });
    return (last && last.confessionId) ? last.confessionId + 1 : 1000;
}

function getGrowthStage(days) {
    if (days < 3) return '🌱 ዘር (Seed)';
    if (days < 7) return '🌿 ቡቃያ (Sprout)';
    if (days < 14) return '🪴 ተከላ (Planting)';
    if (days < 30) return '🎋 የፅናት ዛፍ (Persistence)';
    if (days < 60) return '🍃 ለምለም (Flourishing)';
    if (days < 90) return '🌳 ዋርካ (Canopy)';
    return '👑 ንጉስ (Legend)';
}

// --- CLEAN UI HELPER ---
async function sendCleanMessage(ctx, text, extra, userId) {
    const user = await User.findOne({ userId });
    // Try delete old message
    if (user && user.lastMenuId) {
        try { await ctx.deleteMessage(user.lastMenuId); } 
        catch (e) { /* Ignore if old */ }
    }
    // Send new
    const sent = await ctx.reply(text, extra);
    // Save new ID
    await User.findOneAndUpdate({ userId }, { lastMenuId: sent.message_id });
    return sent;
}

// ============================================================
// 5. BOT LOGIC
// ============================================================
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return; 

    const userId = String(ctx.from.id);
    const firstName = ctx.from.first_name || 'Friend';
    const user = await User.findOne({ userId });
    if (user && user.isBanned) return; 

    await User.findOneAndUpdate({ userId }, { firstName, lastActive: new Date() }, { upsert: true });
    if (ADMIN_IDS.includes(userId)) await clearAdminStep(userId);

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const communityLabel = await getConfig('comm_btn_label', '🗣 Confessions');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');

    const defaultLayout = [[urgeLabel, streakLabel], [communityLabel, channelLabel]];
    let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
    let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;

    const currentLabels = new Set(layout.flat().map(l => l.trim()));
    if (!currentLabels.has(communityLabel)) {
        if (layout.length >= 2) layout[1].unshift(communityLabel); else layout.push([communityLabel]);
    }

    const customBtns = await CustomButton.find({});
    const updatedLabels = new Set(layout.flat().map(l => l.trim())); 
    let tempRow = [];
    customBtns.forEach(btn => {
        if (!updatedLabels.has(btn.label.trim())) {
            tempRow.push(btn.label);
            if (tempRow.length === 2) { layout.push(tempRow); tempRow = []; }
        }
    });
    if (tempRow.length > 0) layout.push(tempRow);

    if (ADMIN_IDS.includes(userId)) {
        if (!layout.flat().includes('🔐 Admin Panel')) layout.push(['🔐 Admin Panel']);
    }

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${firstName}! እንኳን በሰላም መጣህ።`);
    
    // Use Clean Message Logic
    await sendCleanMessage(ctx, welcomeMsg, Markup.keyboard(layout).resize(), userId);

  } catch (e) { console.error(e); }
});

bot.command('profile', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    showProfile(ctx, String(ctx.from.id));
});

bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    if (!ctx.message) return;
    try {
        const userId = String(ctx.from.id);
        const text = ctx.message.text; 
        
        if (ctx.chat.type !== 'private') return; 

        const currentUser = await User.findOne({ userId });
        if (currentUser && currentUser.isBanned) return;
        await User.findOneAndUpdate({ userId }, { lastActive: new Date() });

        // === ADMIN WIZARD ===
        if (ADMIN_IDS.includes(userId)) {
            const state = await getAdminState(userId);
            if (state && state.step) {
                if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
                
                // --- SIMPLIFIED BROADCAST (NO LINK WIZARD) ---
                if (state.step === 'awaiting_broadcast_content') {
                    // Save necessary info to copy message
                    const broadcastData = {
                        fromChatId: ctx.chat.id,
                        messageId: ctx.message.message_id
                    };
                    
                    await setAdminStep(userId, 'awaiting_broadcast_confirm', broadcastData);

                    // Show Preview (Copy exact message)
                    await ctx.reply('👁 **Preview:**');
                    try {
                        await ctx.telegram.copyMessage(ctx.chat.id, broadcastData.fromChatId, broadcastData.messageId);
                    } catch (e) {
                        return ctx.reply('❌ Preview Error.');
                    }

                    return ctx.reply('✅ ይላክ? /confirm ብለው ያረጋግጡ።');
                }

                if (state.step === 'awaiting_broadcast_confirm') {
                    if (text === '/confirm') {
                        const data = state.tempData;
                        const users = await User.find({});
                        let success = 0, fail = 0;
                        
                        await ctx.reply(`🚀 Broadcasting to ${users.length} users...`);
                        
                        (async () => {
                            for (const u of users) {
                                try {
                                    // copyMessage preserves everything (Text, Media, Captions)
                                    // NOTE: Forwarded buttons are stripped by Telegram API.
                                    await bot.telegram.copyMessage(u.userId, data.fromChatId, data.messageId);
                                    success++;
                                } catch (e) { fail++; }
                                await new Promise(r => setTimeout(r, 30)); 
                            }
                            try { await bot.telegram.sendMessage(userId, `📢 **Broadcast Report**\n\n✅ Sent: ${success}\n❌ Failed: ${fail}`); } catch(e){}
                        })();

                        await clearAdminStep(userId);
                        return;
                    } else {
                        return ctx.reply('Type /confirm to send or /cancel to stop.');
                    }
                }

                // ... Other Admin Logic ...
                if (state.step === 'awaiting_ban_id') { await User.findOneAndUpdate({ userId: text.trim() }, { isBanned: true }); await ctx.reply(`🚫 Banned.`); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_welcome') { await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true }); await ctx.reply('✅ Saved!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_channel_name') { await setAdminStep(userId, 'awaiting_channel_link', { name: text }); return ctx.reply('🔗 Link:'); }
                if (state.step === 'awaiting_channel_link') { await Channel.create({ name: state.tempData.name, link: text }); await ctx.reply('✅ Added!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_motivation') { await Motivation.create({ text }); await ctx.reply('✅ Added!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_btn_name') { await setAdminStep(userId, 'awaiting_btn_content', { label: text }); return ctx.reply('📥 Content:'); }
                if (state.step === 'awaiting_btn_content') {
                    let type = 'text', content = '', caption = ctx.message.caption || '';
                    if (ctx.message.voice) { type = 'voice'; content = ctx.message.voice.file_id; }
                    else if (ctx.message.photo) { type = 'photo'; content = ctx.message.photo[ctx.message.photo.length - 1].file_id; }
                    else if (ctx.message.video) { type = 'video'; content = ctx.message.video.file_id; }
                    else if (text) { content = text; } else return ctx.reply('Invalid.');
                    await setAdminStep(userId, 'awaiting_btn_links', { label: state.tempData.label, type, content, caption });
                    return ctx.reply('🔗 Links? (Send "No" to skip)');
                }
                if (state.step === 'awaiting_btn_links') {
                    let inlineLinks = [];
                    if (text && text.toLowerCase() !== 'no') {
                        const lines = text.split('\n');
                        for (let line of lines) {
                            const parts = line.split('-');
                            if (parts.length >= 2) {
                                const label = parts[0].trim(); const url = parts.slice(1).join('-').trim();
                                if (label && url.startsWith('http')) inlineLinks.push({ label, url });
                            } else if (line.startsWith('http')) inlineLinks.push({ label: '🔗 Open Link', url: line.trim() });
                        }
                    }
                    await CustomButton.findOneAndUpdate({ label: state.tempData.label }, { type: state.tempData.type, content: state.tempData.content, caption: state.tempData.caption, inlineLinks: inlineLinks }, { upsert: true, new: true });
                    await ctx.reply(`✅ Created!`); await clearAdminStep(userId); return;
                }
            }
        }

        // === USER STATE ===
        const userState = await getAdminState(userId);
        if (userState && userState.step === 'edit_nickname') { await User.findOneAndUpdate({ userId }, { nickname: text }); await clearAdminStep(userId); await ctx.reply('✅ Nickname updated!'); return showProfile(ctx, userId); }
        if (userState && userState.step === 'edit_bio') { await User.findOneAndUpdate({ userId }, { bio: text }); await clearAdminStep(userId); await ctx.reply('✅ Bio updated!'); return showProfile(ctx, userId); }
        if (userState && userState.step === 'edit_emoji') { await User.findOneAndUpdate({ userId }, { emoji: text }); await clearAdminStep(userId); await ctx.reply('✅ Emoji updated!'); return showProfile(ctx, userId); }
        
        if (userState && userState.step === 'awaiting_confession') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
            if (!text) return ctx.reply('Text only please.');
            await Post.create({ userId, authorName: currentUser.nickname || "Anonymous", text: text, status: 'pending' });
            await clearAdminStep(userId);
            await ctx.reply('📜 **Received!** Sent to admins.', { parse_mode: 'Markdown' });
            return;
        }
        
        if (userState && userState.step === 'awaiting_comment') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
            const postId = userState.tempData.postId;
            await Comment.create({ postId, userId, authorName: currentUser.nickname || "Anonymous", text: text });
            await User.findOneAndUpdate({ userId }, { $inc: { aura: 2 } }); 
            await clearAdminStep(userId);
            await ctx.reply('✅ Comment added!');
            return;
        }

        if (userState && userState.step === 'awaiting_reply_comment') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
            const commentId = userState.tempData.commentId;
            const replyName = currentUser.nickname || "Anonymous";
            await Comment.findByIdAndUpdate(commentId, { $push: { replies: { authorName: replyName, text: text } } });
            await clearAdminStep(userId);
            await ctx.reply('✅ Reply sent!');
            return;
        }

        // === MENU INTERACTIONS ===
        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) return showAdminMenu(ctx);

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('Empty.');
            const m = await Motivation.findOne().skip(Math.floor(Math.random() * count));
            return sendCleanMessage(ctx, `🛡️ **Stay Strong!**\n\n${m.text}`, { parse_mode: 'Markdown' }, userId);
        }

        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        if (text === streakLabel) return handleStreak(ctx);

        const communityLabel = await getConfig('comm_btn_label', '🗣 Confessions');
        if (text === communityLabel) {
            if (ctx.chat.type !== 'private') {
                return ctx.reply('⚠️ ለምስጢራዊነት ሲባል ይህ አገልግሎት በግል (Private Chat) ብቻ ነው የሚሰራው።', Markup.inlineKeyboard([[Markup.button.url('Go to Private Chat', `https://t.me/${ctx.botInfo.username}`)]]));
            }
            return handleConfessions(ctx);
        }

        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        if (text === channelLabel) {
            const channels = await Channel.find({});
            const btns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return sendCleanMessage(ctx, 'Channels:', Markup.inlineKeyboard(btns), userId);
        }

        const customBtn = await CustomButton.findOne({ label: text });
        if (customBtn) {
            let extra = { parse_mode: 'Markdown' };
            if (customBtn.caption) extra.caption = customBtn.caption;
            if (customBtn.inlineLinks && customBtn.inlineLinks.length > 0) {
                const linkBtns = customBtn.inlineLinks.map(l => [Markup.button.url(l.label, l.url)]);
                extra.reply_markup = { inline_keyboard: linkBtns };
            }
            
            const user = await User.findOne({ userId });
            if (user && user.lastMenuId) try { await ctx.deleteMessage(user.lastMenuId); } catch(e){}

            let sent;
            if (customBtn.type === 'photo') sent = await ctx.replyWithPhoto(customBtn.content, extra);
            if (customBtn.type === 'video') sent = await ctx.replyWithVideo(customBtn.content, extra);
            if (customBtn.type === 'voice') sent = await ctx.replyWithVoice(customBtn.content, extra);
            if (customBtn.type === 'text') sent = await ctx.reply(customBtn.content, extra);
            
            if(sent) await User.findOneAndUpdate({ userId }, { lastMenuId: sent.message_id });
            return;
        }
    } catch (e) { console.error(e); }
});

// ============================================================
// 6. LOGIC FUNCTIONS
// ============================================================

async function showProfile(ctx, userId) {
    const user = await User.findOne({ userId });
    if (!user) return ctx.reply("User not found.");
    const msg = `👤 *Profile*\n\n🏷️ *Name:* ${escapeMarkdown(user.nickname)}\n🎭 *Emoji:* ${user.emoji}\n⚡️ *Aura:* ${user.aura}\n📝 *Bio:* ${escapeMarkdown(user.bio)}`;
    
    await sendCleanMessage(ctx, msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Name', 'prof_name'), Markup.button.callback('✏️ Edit Bio', 'prof_bio')], [Markup.button.callback('😊 Edit Emoji', 'prof_emoji')], [Markup.button.callback('🔙 Back', 'back_to_menu')]]) }, userId);
}
bot.action('prof_name', async ctx => { await setAdminStep(String(ctx.from.id), 'edit_nickname'); ctx.reply('Enter nickname:'); ctx.answerCbQuery(); });
bot.action('prof_bio', async ctx => { await setAdminStep(String(ctx.from.id), 'edit_bio'); ctx.reply('Enter bio:'); ctx.answerCbQuery(); });
bot.action('prof_emoji', async ctx => { await setAdminStep(String(ctx.from.id), 'edit_emoji'); ctx.reply('Send emoji:'); ctx.answerCbQuery(); });

async function handleConfessions(ctx) {
    const userId = String(ctx.from.id);
    await sendCleanMessage(
        ctx,
        '🗣 **Confessions & Support**',
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📜 Browse Confessions', 'browse_confessions_0')],
                [Markup.button.callback('➕ Post Confession', 'write_confession')],
                [Markup.button.callback('👤 My Profile', 'my_profile')],
                [Markup.button.callback('🔙 Back to Menu', 'back_to_menu')] 
            ])
        },
        userId
    );
}

bot.action('back_to_menu', async ctx => {
    // Edit the message back to Main Menu instead of delete+send
    try {
        const userId = String(ctx.from.id);
        const welcomeMsg = await getConfig('welcome_msg', `Welcome back!`);
        
        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        const communityLabel = await getConfig('comm_btn_label', '🗣 Confessions');
        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        const defaultLayout = [[urgeLabel, streakLabel], [communityLabel, channelLabel]];
        let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
        let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;
        
        // Ensure Community Button
        const currentLabels = new Set(layout.flat().map(l => l.trim()));
        if (!currentLabels.has(communityLabel)) {
            if (layout.length >= 2) layout[1].unshift(communityLabel); else layout.push([communityLabel]);
        }
        
        // Ensure Admin Button
        if (ADMIN_IDS.includes(userId) && !layout.flat().includes('🔐 Admin Panel')) layout.push(['🔐 Admin Panel']);

        // Since main menu uses Keyboard (ReplyMarkup) not Inline, we MUST send a new message.
        // We cannot "edit" an inline menu into a ReplyKeyboard menu.
        // So we delete old and send new.
        await ctx.deleteMessage();
        const sent = await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
        await User.findOneAndUpdate({ userId }, { lastMenuId: sent.message_id });
        
    } catch (e) { 
        // Fallback
        const sent = await ctx.reply('Menu', Markup.keyboard([['Start']]).resize());
    }
    await ctx.answerCbQuery();
});

bot.action('my_profile', ctx => showProfile(ctx, String(ctx.from.id)));
bot.action('write_confession', async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_confession');
    await ctx.reply('✍️ Write your confession (Text only):');
    await ctx.answerCbQuery();
});

bot.action(/^browse_confessions_(\d+)$/, async ctx => {
    const page = parseInt(ctx.match[1]);
    const limit = 10;
    const skip = page * limit;
    const posts = await Post.find({ status: 'approved' }).sort({ createdAt: -1 }).skip(skip).limit(limit);
    const totalPosts = await Post.countDocuments({ status: 'approved' });
    
    if (posts.length === 0 && page === 0) { await ctx.reply('No confessions yet.'); return ctx.answerCbQuery(); }

    let btns = [];
    posts.forEach(p => {
        const idDisplay = p.confessionId ? `#${p.confessionId}` : 'Confession'; 
        const preview = p.text.substring(0, 30) + '...';
        btns.push([Markup.button.callback(`${idDisplay}: ${preview}`, `view_conf_${p._id}`)]);
    });

    let navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `browse_confessions_${page - 1}`));
    if (skip + limit < totalPosts) navRow.push(Markup.button.callback('Next ➡️', `browse_confessions_${page + 1}`));
    if (navRow.length > 0) btns.push(navRow);
    
    btns.push([Markup.button.callback('🔙 Back', 'back_to_menu')]);
    
    const title = page === 0 ? '👇 Select a Confession:' : `👇 Page ${page + 1}:`;
    try { await ctx.editMessageText(title, Markup.inlineKeyboard(btns)); } catch (e) { await sendCleanMessage(ctx, title, Markup.inlineKeyboard(btns), String(ctx.from.id)); }
    await ctx.answerCbQuery();
});

bot.action(/^view_conf_(.+)$/, async ctx => {
    try {
        const post = await Post.findById(ctx.match[1]);
        if (!post) return ctx.answerCbQuery('Deleted');

        const commentCount = await Comment.countDocuments({ postId: post._id });
        const upCount = post.upvotes ? post.upvotes.length : 0;
        const downCount = post.downvotes ? post.downvotes.length : 0;
        const idDisplay = post.confessionId ? `#${post.confessionId}` : 'Confession';

        let msg = `*${escapeMarkdown(idDisplay)}*\n`;
        msg += `────────────────\n`;
        msg += `${escapeMarkdown(post.text)}\n`;
        msg += `────────────────\n`;
        msg += `👤 *${escapeMarkdown(post.authorName)}*`;

        try {
            await ctx.editMessageText(msg, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard([
                    [
                        Markup.button.callback(`👍 ${upCount}`, `vote_up_${post._id}`),
                        Markup.button.callback(`👎 ${downCount}`, `vote_down_${post._id}`),
                        Markup.button.callback(`💬 Reply`, `add_comment_${post._id}`)
                    ],
                    [Markup.button.callback(`📂 Browse Comments (${commentCount})`, `view_comments_${post._id}_0`)],
                    [Markup.button.callback('🔙 Back', `browse_confessions_0`)]
                ])
            });
        } catch (e) {
             await sendCleanMessage(ctx, msg, {
                parse_mode: 'MarkdownV2',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback(`👍 ${upCount}`, `vote_up_${post._id}`), Markup.button.callback(`👎 ${downCount}`, `vote_down_${post._id}`), Markup.button.callback(`💬 Reply`, `add_comment_${post._id}`)],
                    [Markup.button.callback(`📂 Browse Comments (${commentCount})`, `view_comments_${post._id}_0`)],
                    [Markup.button.callback('🔙 Back', `browse_confessions_0`)]
                ])
            }, String(ctx.from.id));
        }
        await ctx.answerCbQuery();
    } catch(e) { console.error(e); ctx.answerCbQuery("Error"); }
});

bot.action(/^vote_(up|down)_(.+)$/, async ctx => {
    const type = ctx.match[1];
    const postId = ctx.match[2];
    const userId = String(ctx.from.id);
    const post = await Post.findById(postId);
    if (!post) return ctx.answerCbQuery('Not found');

    let up = post.upvotes || [];
    let down = post.downvotes || [];
    if (up.includes(userId)) up = up.filter(id => id !== userId);
    if (down.includes(userId)) down = down.filter(id => id !== userId);
    if (type === 'up') up.push(userId); else down.push(userId);

    await Post.findByIdAndUpdate(postId, { upvotes: up, downvotes: down });
    const commentCount = await Comment.countDocuments({ postId: post._id });
    
    try {
        await ctx.editMessageReplyMarkup({
            inline_keyboard: [
                [
                    Markup.button.callback(`👍 ${up.length}`, `vote_up_${postId}`),
                    Markup.button.callback(`👎 ${down.length}`, `vote_down_${postId}`),
                    Markup.button.callback(`💬 Reply`, `add_comment_${postId}`)
                ],
                [Markup.button.callback(`📂 Browse Comments (${commentCount})`, `view_comments_${postId}_0`)],
                [Markup.button.callback('🔙 Back', `browse_confessions_0`)]
            ]
        });
    } catch(e) {}
    ctx.answerCbQuery(type === 'up' ? 'Liked!' : 'Disliked');
});

bot.action(/^add_comment_(.+)$/, async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_comment', { postId: ctx.match[1] });
    await ctx.reply('✍️ Write your comment (Text only):', { reply_markup: { force_reply: true } });
    await ctx.answerCbQuery();
});

bot.action(/^view_comments_([a-f\d]+)_(\d+)$/, async ctx => {
    const postId = ctx.match[1];
    const page = parseInt(ctx.match[2]);
    const limit = 1; 
    const skip = page * limit;

    const comments = await Comment.find({ postId: postId }).sort({ createdAt: 1 }).skip(skip).limit(limit);
    const totalComments = await Comment.countDocuments({ postId: postId });

    if (totalComments === 0) {
        await ctx.reply('No comments yet.');
        return ctx.answerCbQuery();
    }

    const c = comments[0];
    const upCount = c.upvotes ? c.upvotes.length : 0;
    const downCount = c.downvotes ? c.downvotes.length : 0;

    let msg = `💬 *Comment \\(${page + 1}/${totalComments}\\)*\n\n`;
    msg += `👤 *${escapeMarkdown(c.authorName)}*:\n${escapeMarkdown(c.text)}\n`;
    
    if (c.replies && c.replies.length > 0) {
        msg += `\n*Replies:*\n`;
        c.replies.forEach(r => msg += `▫️ _${escapeMarkdown(r.authorName)}:_ ${escapeMarkdown(r.text)}\n`);
    }

    let buttons = [
        [
            Markup.button.callback(`👍 ${upCount}`, `cvote_up_${c._id}_${postId}_${page}`),
            Markup.button.callback(`👎 ${downCount}`, `cvote_down_${c._id}_${postId}_${page}`),
            Markup.button.callback(`↩️ Reply`, `creply_${c._id}`)
        ]
    ];

    let navRow = [];
    if (page > 0) navRow.push(Markup.button.callback('⬅️ Prev', `view_comments_${postId}_${page - 1}`));
    if (skip + limit < totalComments) navRow.push(Markup.button.callback('Next ➡️', `view_comments_${postId}_${page + 1}`));
    if (navRow.length > 0) buttons.push(navRow);
    
    buttons.push([Markup.button.callback('🔙 Back to Post', `view_conf_${postId}`)]);

    try { await ctx.editMessageText(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) }); } 
    catch(e) { await ctx.reply(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard(buttons) }); }
    
    await ctx.answerCbQuery();
});

bot.action(/^cvote_(up|down)_([a-f\d]+)_([a-f\d]+)_(\d+)$/, async ctx => {
    const type = ctx.match[1];
    const commentId = ctx.match[2];
    const userId = String(ctx.from.id);

    const comment = await Comment.findById(commentId);
    if (!comment) return ctx.answerCbQuery('Error');

    let up = comment.upvotes || [];
    let down = comment.downvotes || [];
    
    if (up.includes(userId)) up = up.filter(id => id !== userId);
    if (down.includes(userId)) down = down.filter(id => id !== userId);
    if (type === 'up') up.push(userId); else down.push(userId);

    await Comment.findByIdAndUpdate(commentId, { upvotes: up, downvotes: down });
    ctx.answerCbQuery('Voted!');
});

bot.action(/^creply_(.+)$/, async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_reply_comment', { commentId: ctx.match[1] });
    await ctx.reply('✍️ Write your reply:', { reply_markup: { force_reply: true } });
    await ctx.answerCbQuery();
});

async function handleStreak(ctx) {
    try {
        const userId = String(ctx.from.id);
        let user = await User.findOne({ userId });
        if (!user) user = await User.create({ userId, firstName: ctx.from.first_name });
        const diff = Math.floor(Math.abs(new Date() - user.streakStart) / 86400000);
        const stage = getGrowthStage(diff); 
        const name = escapeMarkdown(user.nickname === "Anonymous" ? user.firstName : user.nickname);
        const escapedStage = escapeMarkdown(stage);
        const msg = `🔥 *${name}*\n\n📆 Streak: *${diff} Days*\n🌱 Level: *${escapedStage}*\n🏆 Best: ${user.bestStreak}`;
        
        await sendCleanMessage(ctx, msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('💔 Relapse', `rel_${userId}`)], [Markup.button.callback('🏆 Leaderboard', `led_${userId}`)], [Markup.button.callback('🔄 Refresh', `ref_${userId}`)], [Markup.button.callback('🔙 Back', `back_to_menu`)]]) }, userId);
    } catch(e) { console.error("Streak Error:", e); }
}

bot.action(/^led_(.+)$/, async ctx => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const topUsers = await User.find({ lastActive: { $gte: sevenDaysAgo } }).sort({ streakStart: 1 }).limit(10);
        let msg = '🏆 *Top 10 Active Warriors* 🏆\n_\\(Last 7 Days\\)_\n\n';
        if (topUsers.length === 0) msg += "No active users\\.";
        topUsers.forEach((u, i) => {
            const d = Math.floor(Math.abs(new Date() - u.streakStart) / 86400000);
            const rawName = u.nickname === "Anonymous" ? (u.firstName || 'User') : u.nickname;
            const name = escapeMarkdown(rawName.substring(0, 15));
            msg += `${i+1}\\. ${name} — *${d} days*\n`;
        });
        await ctx.editMessageText(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `ref_${ctx.match[1]}`)]]) });
    } catch (e) { ctx.answerCbQuery("Error"); }
});

const verify = (ctx, id) => String(ctx.from.id) === id;
bot.action(/^rel_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); await ctx.editMessageText('Why?', Markup.inlineKeyboard([[Markup.button.callback('🥱 Bored', `rsn_bor_${ctx.match[1]}`)], [Markup.button.callback('😰 Stress', `rsn_str_${ctx.match[1]}`)], [Markup.button.callback('🔥 Urge', `rsn_urg_${ctx.match[1]}`)], [Markup.button.callback('❌ Cancel', `can_${ctx.match[1]}`)]])); });
bot.action(/^rsn_(.+)_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[2])) return ctx.answerCbQuery('Not allowed'); const u = await User.findOne({ userId: ctx.match[2] }); const d = Math.floor(Math.abs(new Date() - u.streakStart)/86400000); if(d>u.bestStreak)u.bestStreak=d; u.streakStart=new Date(); u.relapseHistory.push({reason:ctx.match[1]}); await u.save(); try{await ctx.deleteMessage();}catch(e){} await ctx.reply('✅ Reset. Stay Strong!'); ctx.answerCbQuery(); });
bot.action(/^ref_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); try{await ctx.deleteMessage();}catch(e){} await handleStreak(ctx); ctx.answerCbQuery(); });
bot.action(/^can_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); try{await ctx.deleteMessage();}catch(e){} ctx.answerCbQuery(); });

async function showAdminMenu(ctx) {
    const c = await User.countDocuments();
    const p = await Post.countDocuments({ status: 'pending' });
    await sendCleanMessage(ctx, `⚙️ Admin (Users: ${c})`, Markup.inlineKeyboard([
        [Markup.button.callback(`⏳ Approvals (${p})`, 'adm_approve')],
        [Markup.button.callback('📢 Broadcast', 'adm_cast'), Markup.button.callback('🔨 Ban', 'adm_ban')],
        [Markup.button.callback('📢 Channel', 'adm_chan'), Markup.button.callback('🔘 Custom', 'adm_cus')],
        [Markup.button.callback('🔙 Back', `back_to_menu`)]
    ]), String(ctx.from.id));
}

bot.action('adm_ban', async ctx => { await setAdminStep(String(ctx.from.id), 'awaiting_ban_id'); await ctx.reply('Send User ID:'); await ctx.answerCbQuery(); });

bot.action('adm_cast', async ctx => { await setAdminStep(String(ctx.from.id), 'awaiting_broadcast_content'); await ctx.reply('📢 Send message (Text/Image/Video) to broadcast:'); await ctx.answerCbQuery(); });

bot.action('adm_approve', async ctx => {
    const pendings = await Post.find({ status: 'pending' }).limit(1);
    if (pendings.length === 0) { await ctx.reply('No pending posts.'); return ctx.answerCbQuery(); }
    const p = pendings[0];
    await ctx.reply(`📝 **From ${p.authorName}**\n\n${p.text}`, Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_yes_${p._id}`), Markup.button.callback('❌ Reject', `app_no_${p._id}`)]]));
    await ctx.answerCbQuery();
});
bot.action(/^app_yes_(.+)$/, async ctx => { 
    const nextId = await getNextConfessionId();
    await Post.findByIdAndUpdate(ctx.match[1], { status: 'approved', confessionId: nextId });
    const p = await Post.findById(ctx.match[1]);
    await User.findOneAndUpdate({ userId: p.userId }, { $inc: { aura: 10 } });
    await ctx.deleteMessage(); await ctx.reply(`Approved as #${nextId}!`); 
});
bot.action(/^app_no_(.+)$/, async ctx => { await Post.findByIdAndDelete(ctx.match[1]); await ctx.deleteMessage(); await ctx.reply('Deleted.'); });

const ask = (ctx, s, t) => { setAdminStep(String(ctx.from.id), s); ctx.reply(t); ctx.answerCbQuery(); };
bot.action('adm_chan', async c => { const ch = await Channel.find({}); c.editMessageText('Channels:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_ch')], ...ch.map(x=>[Markup.button.callback(`🗑️ ${x.name}`, `del_ch_${x._id}`)])])); });
bot.action('add_ch', c => ask(c, 'awaiting_channel_name', 'Name:'));
bot.action(/^del_ch_(.+)$/, async c => { await Channel.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });
bot.action('adm_cus', async c => { const b = await CustomButton.find({}); c.editMessageText('Custom:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_cus')], ...b.map(x=>[Markup.button.callback(`🗑️ ${x.label}`, `del_cus_${x._id}`)])])); });
bot.action('add_cus', c => ask(c, 'awaiting_btn_name', 'Name:'));
bot.action(/^del_cus_(.+)$/, async c => { await CustomButton.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Active');
    if (req.method === 'POST') {
        const update = req.body;
        const logic = async () => {
            await connectToDatabase();
            try { await ProcessedUpdate.create({ update_id: update.update_id }); } catch(e) { if(e.code===11000) return; throw e; }
            await bot.handleUpdate(update);
        };
        try { await Promise.race([logic(), new Promise((_, r) => setTimeout(() => r(new Error('Timeout')), 4500))]); } catch(e) {}
    }
    res.status(200).send('OK');
};


