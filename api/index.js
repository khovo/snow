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

// A. Anti-Duplicate
const processedUpdateSchema = new mongoose.Schema({
  update_id: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 3600 }
});
const ProcessedUpdate = mongoose.models.ProcessedUpdate || mongoose.model('ProcessedUpdate', processedUpdateSchema);

// B. Configs (Global Counters etc)
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// C. User Data (Enhanced Profile)
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String, // Telegram Name
  // Profile System
  nickname: { type: String, default: "Anonymous" },
  bio: { type: String, default: "No bio set." },
  emoji: { type: String, default: "👤" },
  aura: { type: Number, default: 0 }, // Score/Reputation
  // Streak System
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  lastActive: { type: Date, default: Date.now },
  isBanned: { type: Boolean, default: false },
  adminState: { step: { type: String, default: null }, tempData: { type: mongoose.Schema.Types.Mixed, default: {} } }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

// D. Channels
const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

// E. Custom Buttons
const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String },
  inlineLinks: [{ label: String, url: String }] 
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

// F. Motivation
const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// G. Confessions / Posts
const postSchema = new mongoose.Schema({
    confessionId: { type: Number, unique: true }, // #1024
    userId: String,
    authorName: String, // Nickname at time of posting
    text: String,
    status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
    upvotes: [String], // Array of UserIDs
    downvotes: [String],
    createdAt: { type: Date, default: Date.now }
});
const Post = mongoose.models.Post || mongoose.model('Post', postSchema);

// H. Comments
const commentSchema = new mongoose.Schema({
    postId: mongoose.Schema.Types.ObjectId,
    userId: String,
    authorName: String,
    text: String,
    createdAt: { type: Date, default: Date.now }
});
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
function escapeMarkdown(text) { if (!text) return ''; return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&'); }

async function getNextConfessionId() {
    const last = await Post.findOne().sort({ confessionId: -1 });
    return last && last.confessionId ? last.confessionId + 1 : 1000;
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

// ============================================================
// 5. BOT LOGIC
// ============================================================
const bot = new Telegraf(BOT_TOKEN);

bot.start(async (ctx) => {
  try {
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
        if (layout.length >= 2) { layout[1].unshift(communityLabel); } 
        else { layout.push([communityLabel]); }
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

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${firstName}! ወደ NoFap Support Bot እንኳን በሰላም መጣህ።`);
    await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
  } catch (e) { console.error(e); }
});

// --- PROFILE COMMAND ---
bot.command('profile', async (ctx) => {
    await showProfile(ctx, String(ctx.from.id));
});

// --- MAIN HANDLER ---
bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    if (!ctx.message) return;
    try {
        const userId = String(ctx.from.id);
        const text = ctx.message.text; 
        
        const currentUser = await User.findOne({ userId });
        if (currentUser && currentUser.isBanned) return;
        await User.findOneAndUpdate({ userId }, { lastActive: new Date() });

        // === ADMIN WIZARD ===
        if (ADMIN_IDS.includes(userId)) {
            const state = await getAdminState(userId);
            if (state && state.step) {
                if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
                // ... (Existing Admin Logic for Layout, Motivation, etc - Kept Compact)
                if (state.step === 'awaiting_ban_id') {
                    await User.findOneAndUpdate({ userId: text.trim() }, { isBanned: true });
                    await ctx.reply(`🚫 Banned.`); await clearAdminStep(userId); return;
                }
                if (state.step === 'awaiting_welcome') { await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true }); await ctx.reply('✅ Saved!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_channel_name') { await setAdminStep(userId, 'awaiting_channel_link', { name: text }); return ctx.reply('🔗 Link:'); }
                if (state.step === 'awaiting_channel_link') { await Channel.create({ name: state.tempData.name, link: text }); await ctx.reply('✅ Added!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_motivation') { await Motivation.create({ text }); await ctx.reply('✅ Added!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_btn_name') { await setAdminStep(userId, 'awaiting_btn_content', { label: text }); return ctx.reply('📥 Content:'); }
                if (state.step === 'awaiting_btn_content') {
                    // Custom button creation logic (same as before)
                    let type = 'text', content = '', caption = ctx.message.caption || '';
                    if (ctx.message.voice) { type = 'voice'; content = ctx.message.voice.file_id; }
                    else if (ctx.message.photo) { type = 'photo'; content = ctx.message.photo[ctx.message.photo.length - 1].file_id; }
                    else if (ctx.message.video) { type = 'video'; content = ctx.message.video.file_id; }
                    else if (text) { content = text; }
                    else return ctx.reply('Invalid.');
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

        // === USER STATE (Profile & Confession) ===
        const userState = await getAdminState(userId);
        
        // 1. Profile Editing
        if (userState && userState.step === 'edit_nickname') {
            await User.findOneAndUpdate({ userId }, { nickname: text });
            await clearAdminStep(userId);
            await ctx.reply('✅ Nickname updated!');
            return showProfile(ctx, userId);
        }
        if (userState && userState.step === 'edit_bio') {
            await User.findOneAndUpdate({ userId }, { bio: text });
            await clearAdminStep(userId);
            await ctx.reply('✅ Bio updated!');
            return showProfile(ctx, userId);
        }
        if (userState && userState.step === 'edit_emoji') {
            await User.findOneAndUpdate({ userId }, { emoji: text });
            await clearAdminStep(userId);
            await ctx.reply('✅ Emoji updated!');
            return showProfile(ctx, userId);
        }

        // 2. Confession / Post
        if (userState && userState.step === 'awaiting_confession') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
            if (!text) return ctx.reply('Text only please.');
            
            // Save as pending
            await Post.create({
                userId,
                authorName: currentUser.nickname || "Anonymous",
                text: text,
                status: 'pending'
            });
            await clearAdminStep(userId);
            await ctx.reply('📜 **Confession Received!**\n\nSent to admins for approval.', { parse_mode: 'Markdown' });
            return;
        }

        // 3. Commenting
        if (userState && userState.step === 'awaiting_comment') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ Canceled.'); }
            
            const postId = userState.tempData.postId;
            await Comment.create({
                postId: postId,
                userId: userId,
                authorName: currentUser.nickname || "Anonymous",
                text: text
            });
            
            // Award Aura
            await User.findOneAndUpdate({ userId }, { $inc: { aura: 2 } }); // 2 Aura for commenting

            await clearAdminStep(userId);
            await ctx.reply('✅ Comment added! (+2 Aura)');
            return; // Don't show menu
        }

        // === MENU INTERACTIONS ===
        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) return showAdminMenu(ctx);

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('Empty.');
            const m = await Motivation.findOne().skip(Math.floor(Math.random() * count));
            // Removed 10-Min rule text, simplified help
            return ctx.reply(`🛡️ **Stay Strong!**\n\n${m.text}`, { parse_mode: 'Markdown' });
        }

        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        if (text === streakLabel) return handleStreak(ctx);

        const communityLabel = await getConfig('comm_btn_label', '🗣 Confessions');
        if (text === communityLabel) return handleConfessions(ctx);

        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        if (text === channelLabel) {
            const channels = await Channel.find({});
            const btns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return ctx.reply('Channels:', Markup.inlineKeyboard(btns));
        }

        // Custom Buttons
        const customBtn = await CustomButton.findOne({ label: text });
        if (customBtn) {
            let extra = { parse_mode: 'Markdown' };
            if (customBtn.caption) extra.caption = customBtn.caption;
            if (customBtn.inlineLinks && customBtn.inlineLinks.length > 0) {
                const linkBtns = customBtn.inlineLinks.map(l => [Markup.button.url(l.label, l.url)]);
                extra.reply_markup = { inline_keyboard: linkBtns };
            }
            if (customBtn.type === 'photo') return ctx.replyWithPhoto(customBtn.content, extra);
            if (customBtn.type === 'video') return ctx.replyWithVideo(customBtn.content, extra);
            if (customBtn.type === 'voice') return ctx.replyWithVoice(customBtn.content, extra);
            return ctx.reply(customBtn.content, extra);
        }
    } catch (e) { console.error(e); }
});

// ============================================================
// 6. LOGIC FUNCTIONS
// ============================================================

// --- PROFILE SYSTEM ---
async function showProfile(ctx, userId) {
    const user = await User.findOne({ userId });
    if (!user) return ctx.reply("User not found.");

    const msg = `👤 **Profile**\n\n` +
                `🏷️ **Name:** ${escapeMarkdown(user.nickname)}\n` +
                `🎭 **Emoji:** ${user.emoji}\n` +
                `⚡️ **Aura:** ${user.aura}\n` +
                `📝 **Bio:** ${escapeMarkdown(user.bio)}`;

    await ctx.reply(msg, {
        parse_mode: 'MarkdownV2',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('✏️ Edit Name', 'prof_name'), Markup.button.callback('✏️ Edit Bio', 'prof_bio')],
            [Markup.button.callback('😊 Edit Emoji', 'prof_emoji')]
        ])
    });
}

bot.action('prof_name', async ctx => {
    await setAdminStep(String(ctx.from.id), 'edit_nickname');
    ctx.reply('Enter new nickname:'); ctx.answerCbQuery();
});
bot.action('prof_bio', async ctx => {
    await setAdminStep(String(ctx.from.id), 'edit_bio');
    ctx.reply('Enter new bio:'); ctx.answerCbQuery();
});
bot.action('prof_emoji', async ctx => {
    await setAdminStep(String(ctx.from.id), 'edit_emoji');
    ctx.reply('Send a single emoji:'); ctx.answerCbQuery();
});

// --- CONFESSION / COMMUNITY SYSTEM ---
async function handleConfessions(ctx) {
    await ctx.reply(
        '🗣 **Confessions & Support**\n\nExpress yourself anonymously or read others.',
        Markup.inlineKeyboard([
            [Markup.button.callback('📜 Browse Confessions', 'browse_confessions')],
            [Markup.button.callback('➕ Post Confession', 'write_confession')],
            [Markup.button.callback('👤 My Profile', 'my_profile')]
        ])
    );
}

bot.action('my_profile', ctx => showProfile(ctx, String(ctx.from.id)));

bot.action('write_confession', async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_confession');
    await ctx.reply('✍️ Write your confession/thought:\n(It will be anonymous/nickname based on your profile)\n\nType /cancel to stop.');
    await ctx.answerCbQuery();
});

// Browse Logic
bot.action('browse_confessions', async ctx => {
    // Show approved posts, newest first
    const posts = await Post.find({ status: 'approved' }).sort({ createdAt: -1 }).limit(10);
    
    if (posts.length === 0) {
        await ctx.reply('No confessions yet.');
        return ctx.answerCbQuery();
    }

    // Instead of list, let's show the latest one, or a list of IDs?
    // User requested "Confession Bot" style where you scroll or see list.
    // Let's list titles (first few words)
    let btns = [];
    posts.forEach(p => {
        const preview = p.text.substring(0, 30) + '...';
        btns.push([Markup.button.callback(`#${p.confessionId}: ${preview}`, `view_conf_${p._id}`)]);
    });
    
    await ctx.reply('👇 Select a Confession:', Markup.inlineKeyboard(btns));
    await ctx.answerCbQuery();
});

// View Single Confession
bot.action(/^view_conf_(.+)$/, async ctx => {
    try {
        const post = await Post.findById(ctx.match[1]);
        if (!post) return ctx.answerCbQuery('Deleted');

        // Count comments
        const commentCount = await Comment.countDocuments({ postId: post._id });
        const upCount = post.upvotes ? post.upvotes.length : 0;
        const downCount = post.downvotes ? post.downvotes.length : 0;

        let msg = `**Confession #${post.confessionId}**\n`;
        msg += `────────────────\n`;
        msg += `${escapeMarkdown(post.text)}\n`;
        msg += `────────────────\n`;
        msg += `👤 ${escapeMarkdown(post.authorName)}`;

        await ctx.reply(msg, {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [
                    Markup.button.callback(`👍 ${upCount}`, `vote_up_${post._id}`),
                    Markup.button.callback(`👎 ${downCount}`, `vote_down_${post._id}`),
                    Markup.button.callback(`💬 Reply`, `add_comment_${post._id}`)
                ],
                [Markup.button.callback(`📂 Browse Comments (${commentCount})`, `view_comments_${post._id}`)]
            ])
        });
        await ctx.answerCbQuery();
    } catch(e) { console.error(e); }
});

// Voting Logic
bot.action(/^vote_(up|down)_(.+)$/, async ctx => {
    const type = ctx.match[1];
    const postId = ctx.match[2];
    const userId = String(ctx.from.id);

    const post = await Post.findById(postId);
    if (!post) return ctx.answerCbQuery('Post not found');

    let up = post.upvotes || [];
    let down = post.downvotes || [];

    // Remove existing vote
    if (up.includes(userId)) up = up.filter(id => id !== userId);
    if (down.includes(userId)) down = down.filter(id => id !== userId);

    // Add new vote
    if (type === 'up') up.push(userId);
    else down.push(userId);

    await Post.findByIdAndUpdate(postId, { upvotes: up, downvotes: down });
    
    // Refresh buttons
    const commentCount = await Comment.countDocuments({ postId: post._id });
    await ctx.editMessageReplyMarkup({
        inline_keyboard: [
            [
                Markup.button.callback(`👍 ${up.length}`, `vote_up_${postId}`),
                Markup.button.callback(`👎 ${down.length}`, `vote_down_${postId}`),
                Markup.button.callback(`💬 Reply`, `add_comment_${postId}`)
            ],
            [Markup.button.callback(`📂 Browse Comments (${commentCount})`, `view_comments_${postId}`)]
        ]
    });
    ctx.answerCbQuery(type === 'up' ? 'Liked!' : 'Disliked');
});

// Add Comment
bot.action(/^add_comment_(.+)$/, async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_comment', { postId: ctx.match[1] });
    await ctx.reply('✍️ Write your comment:', { reply_markup: { force_reply: true } });
    await ctx.answerCbQuery();
});

// View Comments
bot.action(/^view_comments_(.+)$/, async ctx => {
    const comments = await Comment.find({ postId: ctx.match[1] }).sort({ createdAt: 1 }).limit(10); // First 10
    if (comments.length === 0) {
        await ctx.reply('No comments yet. Be the first!');
        return ctx.answerCbQuery();
    }

    let msg = `💬 **Comments**\n\n`;
    comments.forEach(c => {
        msg += `🔸 *${escapeMarkdown(c.authorName)}*: ${escapeMarkdown(c.text)}\n\n`;
    });

    await ctx.reply(msg, { parse_mode: 'MarkdownV2' });
    await ctx.answerCbQuery();
});


// --- STREAK ---
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
        
        await ctx.reply(msg, {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💔 Relapse', `rel_${userId}`)],
                [Markup.button.callback('🏆 Leaderboard', `led_${userId}`)],
                [Markup.button.callback('🔄 Refresh', `ref_${userId}`)]
            ])
        });
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

// --- ADMIN PANEL ---
async function showAdminMenu(ctx) {
    const c = await User.countDocuments();
    const p = await Post.countDocuments({ status: 'pending' });
    await ctx.reply(`⚙️ Admin (Users: ${c})`, Markup.inlineKeyboard([
        [Markup.button.callback(`⏳ Approvals (${p})`, 'adm_approve')],
        [Markup.button.callback('🔨 Ban', 'adm_ban'), Markup.button.callback('📢 Channel', 'adm_chan')],
        [Markup.button.callback('🔘 Custom', 'adm_cus')]
    ]));
}

bot.action('adm_ban', async ctx => { await setAdminStep(String(ctx.from.id), 'awaiting_ban_id'); await ctx.reply('Send User ID:'); await ctx.answerCbQuery(); });

bot.action('adm_approve', async ctx => {
    const pendings = await Post.find({ status: 'pending' }).limit(1);
    if (pendings.length === 0) { await ctx.reply('No pending posts.'); return ctx.answerCbQuery(); }
    const p = pendings[0];
    await ctx.reply(`📝 **From ${p.authorName}**\n\n${p.text}`, Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_yes_${p._id}`), Markup.button.callback('❌ Reject', `app_no_${p._id}`)]]));
    await ctx.answerCbQuery();
});
bot.action(/^app_yes_(.+)$/, async ctx => { 
    // Assign Confession ID
    const nextId = await getNextConfessionId();
    await Post.findByIdAndUpdate(ctx.match[1], { status: 'approved', confessionId: nextId });
    // Add Aura to user
    const p = await Post.findById(ctx.match[1]);
    await User.findOneAndUpdate({ userId: p.userId }, { $inc: { aura: 10 } }); // 10 Aura for approved post
    
    await ctx.deleteMessage(); 
    await ctx.reply(`Approved as #${nextId}!`); 
});
bot.action(/^app_no_(.+)$/, async ctx => { await Post.findByIdAndDelete(ctx.match[1]); await ctx.deleteMessage(); await ctx.reply('Deleted.'); });

// Standard Admin
const ask = (ctx, s, t) => { setAdminStep(String(ctx.from.id), s); ctx.reply(t); ctx.answerCbQuery(); };
bot.action('adm_chan', async c => { const ch = await Channel.find({}); c.editMessageText('Channels:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_ch')], ...ch.map(x=>[Markup.button.callback(`🗑️ ${x.name}`, `del_ch_${x._id}`)])])); });
bot.action('add_ch', c => ask(c, 'awaiting_channel_name', 'Name:'));
bot.action(/^del_ch_(.+)$/, async c => { await Channel.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });
bot.action('adm_cus', async c => { const b = await CustomButton.find({}); c.editMessageText('Custom:', Markup.inlineKeyboard([[Markup.button.callback('➕ Add', 'add_cus')], ...b.map(x=>[Markup.button.callback(`🗑️ ${x.label}`, `del_cus_${x._id}`)])])); });
bot.action('add_cus', c => ask(c, 'awaiting_btn_name', 'Name:'));
bot.action(/^del_cus_(.+)$/, async c => { await CustomButton.findByIdAndDelete(c.match[1]); c.reply('Deleted'); c.answerCbQuery(); });

// ============================================================
// 7. SERVERLESS EXPORT
// ============================================================
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


