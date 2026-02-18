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

// B. Configs
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// C. User Data
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ date: { type: Date, default: Date.now }, reason: String }],
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

// G. Community Posts
const postSchema = new mongoose.Schema({
    userId: String,
    userName: String,
    text: String,
    status: { type: String, enum: ['pending', 'approved'], default: 'pending' },
    replies: [{ userId: String, userName: String, text: String, date: { type: Date, default: Date.now } }],
    createdAt: { type: Date, default: Date.now }
});
const Post = mongoose.models.Post || mongoose.model('Post', postSchema);

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

// Robust MarkdownV2 Escaping (Crucial for preventing crashes)
function escapeMarkdown(text) {
    if (!text) return '';
    return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function getGrowthStage(days) {
    if (days < 3) return '🌱 ዘር (Seed)';
    if (days < 7) return '🌿 ቡቃያ (Sprout)';
    if (days < 14) return '🪴 ተከላ (Planting)';
    if (days < 21) return '🌳 ትንሹ ዛፍ (Sapling)';
    if (days < 30) return '🎋 የፅናት ዛፍ (Persistence)';
    if (days < 40) return '🌲 ስር የሰደደ (Deep Rooted)';
    if (days < 50) return '🪵 ጠንካራ ግንድ (Strong Trunk)';
    if (days < 60) return '🍃 ለምለም (Flourishing)';
    if (days < 70) return '🌸 አበቦች (Flowering)';
    if (days < 80) return '🍒 ፍሬያማ (Fruiting)';
    if (days < 90) return '🌳 የዋርካ ጥላ (Canopy)';
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
    
    // Check Ban
    const user = await User.findOne({ userId });
    if (user && user.isBanned) return; 

    await User.findOneAndUpdate({ userId }, { firstName, lastActive: new Date() }, { upsert: true });
    if (ADMIN_IDS.includes(userId)) await clearAdminStep(userId);

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const communityLabel = await getConfig('comm_btn_label', '💬 የጥንካሬ መድረክ');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');

    const defaultLayout = [[urgeLabel, streakLabel], [communityLabel, channelLabel]];
    let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
    let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;

    // Force Add Community Button if missing
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

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${firstName}! እንኳን በሰላም መጣህ።`);
    await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
  } catch (e) { console.error(e); }
});

bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    if (!ctx.message) return;
    try {
        const userId = String(ctx.from.id);
        const text = ctx.message.text; 
        
        // BAN CHECK
        const currentUser = await User.findOne({ userId });
        if (currentUser && currentUser.isBanned) return;

        await User.findOneAndUpdate({ userId }, { lastActive: new Date() });

        // === ADMIN WIZARD ===
        if (ADMIN_IDS.includes(userId)) {
            const state = await getAdminState(userId);
            if (state && state.step) {
                if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ ሂደቱ ተሰርዟል።'); }
                
                if (state.step === 'awaiting_ban_id') {
                    if (!text) return ctx.reply('ID ቁጥር ብቻ።');
                    await User.findOneAndUpdate({ userId: text.trim() }, { isBanned: true });
                    await ctx.reply(`🚫 User ${text} has been BANNED.`);
                    await clearAdminStep(userId); return;
                }
                if (state.step === 'awaiting_welcome') { await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true }); await ctx.reply('✅ Saved!'); await clearAdminStep(userId); return; }
                if (state.step === 'awaiting_channel_name') { await setAdminStep(userId, 'awaiting_channel_link', { name: text }); return ctx.reply('🔗 Link:'); }
                if (state.step === 'awaiting_channel_link') { await Channel.create({ name: state.tempData.name, link: text }); await ctx.reply('✅ Added!'); await clearAdminStep(userId); return; }
                
                if (state.step === 'awaiting_btn_name') { await setAdminStep(userId, 'awaiting_btn_content', { label: text }); return ctx.reply('📥 Content:'); }
                if (state.step === 'awaiting_btn_content') {
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

        // === USER POSTING ===
        const userState = await getAdminState(userId);
        
        // 1. New Post
        if (userState && userState.step === 'awaiting_post_text') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ ተሰርዟል።'); }
            if (!text) return ctx.reply('ፅሁፍ ብቻ ነው የሚቻለው።');
            await setAdminStep(userId, 'awaiting_post_anon', { text: text });
            return ctx.reply('👤 ስምዎ ይታይ ወይስ በድብቅ?', Markup.inlineKeyboard([
                [Markup.button.callback('✅ ስሜ ይታይ', 'post_show_name')],
                [Markup.button.callback('🕵️ በድብቅ', 'post_hide_name')]
            ]));
        }
        
        // 2. Replying to Post
        if (userState && userState.step === 'awaiting_reply_text') {
            if (text === '/cancel') { await clearAdminStep(userId); return ctx.reply('❌ ተሰርዟል።'); }
            if (!text) return ctx.reply('ፅሁፍ ብቻ።');
            
            const postId = userState.tempData.postId;
            const replyName = (ctx.from.first_name || 'User');
            
            // Add reply to DB
            const updatedPost = await Post.findByIdAndUpdate(postId, { 
                $push: { replies: { userId: userId, userName: replyName, text: text } } 
            }, { new: true });

            await clearAdminStep(userId);
            await ctx.reply('✅ መልስዎ ተጨምሯል!');

            // --- NOTIFICATION SYSTEM ---
            // Notify the original author
            if (updatedPost && updatedPost.userId && updatedPost.userId !== userId) {
                try {
                    await bot.telegram.sendMessage(
                        updatedPost.userId, 
                        `🔔 **አዲስ ምላሽ!**\n\nአንድ ሰው ለፃፉት ፅሁፍ መልስ ሰጥቷል:\n\n💬 "${escapeMarkdown(text)}"`,
                        { parse_mode: 'MarkdownV2' }
                    );
                } catch (err) {
                    console.log("Failed to notify user (blocked bot?)", err.message);
                }
            }
            return;
        }

        // === MENU INTERACTIONS ===
        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) return showAdminMenu(ctx);

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('Empty.');
            const m = await Motivation.findOne().skip(Math.floor(Math.random() * count));
            return ctx.reply(`⏳ **የ10 ደቂቃ ህግ!**\n\nውሳኔ ከመወሰንህ በፊት እባክህ ለ10 ደቂቃ ብቻ ታገስ። ስሜቱ ማዕበል ነው፣ ይመጣል ይሄዳል።\n\n💡 **ምክር:**\n${m.text}`, { parse_mode: 'Markdown' });
        }

        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        if (text === streakLabel) return handleStreak(ctx);

        const communityLabel = await getConfig('comm_btn_label', '💬 የጥንካሬ መድረክ');
        if (text === communityLabel) return handleCommunity(ctx);

        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        if (text === channelLabel) {
            const channels = await Channel.find({});
            const btns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return ctx.reply('Channels:', Markup.inlineKeyboard(btns));
        }

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

// --- COMMUNITY ---
async function handleCommunity(ctx) {
    await ctx.reply(
        '💬 *የጥንካሬ መድረክ*\n\nሀሳብ ያጋሩ፣ ለሌሎች መልስ ይስጡ።\n\\(ሁሉም ፅሁፍ በአድሚን ከፀደቀ በኋላ ይለቀቃል\\)',
        {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📖 አንብብ', 'read_posts')],
                [Markup.button.callback('✍️ ፃፍ', 'write_post')]
            ])
        }
    );
}
bot.action('write_post', async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_post_text');
    await ctx.reply('✍️ መልእክትዎን ይፃፉ:\n(ለመሰረዝ /cancel ይበሉ)');
    await ctx.answerCbQuery();
});
bot.action('post_show_name', async ctx => postFinalize(ctx, false));
bot.action('post_hide_name', async ctx => postFinalize(ctx, true));

async function postFinalize(ctx, isAnon) {
    const userId = String(ctx.from.id);
    const state = await getAdminState(userId);
    if (!state || !state.tempData.text) return ctx.reply('Error.');
    const name = isAnon ? '🕵️ Anonymous' : (ctx.from.first_name || 'User');
    await Post.create({ userId, userName: name, text: state.tempData.text, status: 'pending' });
    await clearAdminStep(userId);
    await ctx.editMessageText('✅ ተልኳል! አድሚን ካጸደቀው በኋላ ይለቀቃል።');
}

bot.action('read_posts', async ctx => {
    // Show APPROVED posts only
    const posts = await Post.find({ status: 'approved' }).sort({ createdAt: -1 }).limit(10);
    
    if (posts.length === 0) { 
        await ctx.reply('ለጊዜው ምንም ፅሁፍ የለም።'); 
        return ctx.answerCbQuery(); 
    }
    
    let btns = [];
    posts.forEach(p => {
        // Safe preview
        let preview = p.text.length > 20 ? p.text.substring(0, 20) + '...' : p.text;
        preview = `${p.userName}: ${preview}`;
        btns.push([Markup.button.callback(preview, `view_post_${p._id}`)]);
    });
    
    await ctx.reply('👇 ለመክፈት ይጫኑ:', Markup.inlineKeyboard(btns));
    await ctx.answerCbQuery();
});

bot.action(/^view_post_(.+)$/, async ctx => {
    try {
        const post = await Post.findById(ctx.match[1]);
        if (!post) {
            await ctx.reply('ይህ ፅሁፍ ጠፍቷል።');
            return ctx.answerCbQuery();
        }

        // FORMATTED DISPLAY (FIXED MARKDOWN)
        let msg = `👤 *${escapeMarkdown(post.userName)}*\n`;
        msg += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`;
        msg += `${escapeMarkdown(post.text)}\n`;
        msg += `\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\\-\n`;
        
        const replyCount = post.replies ? post.replies.length : 0;
        msg += `💬 *${escapeMarkdown(`መልሶች (${replyCount})`)}*\n\n`;

        if (replyCount > 0) {
            post.replies.forEach((r, idx) => {
                msg += `🔸 *${escapeMarkdown(r.userName)}*:\n${escapeMarkdown(r.text)}\n\n`;
            });
        } else {
            msg += `_እስካሁን ምንም መልስ የለም_\n`;
        }

        await ctx.reply(msg, { 
            parse_mode: 'MarkdownV2', 
            ...Markup.inlineKeyboard([[Markup.button.callback('↩️ መልስ ስጥ (Reply)', `reply_to_${post._id}`)]]) 
        });
        await ctx.answerCbQuery();
    } catch(e) { 
        console.error(e);
        ctx.answerCbQuery('Error displaying post');
    }
});

bot.action(/^reply_to_(.+)$/, async ctx => {
    await setAdminStep(String(ctx.from.id), 'awaiting_reply_text', { postId: ctx.match[1] });
    await ctx.reply('✍️ መልስዎን ይፃፉ:\n(ለመሰረዝ /cancel ይበሉ)');
    await ctx.answerCbQuery();
});

// --- STREAK & GROWTH ---
async function handleStreak(ctx) {
    try {
        const userId = String(ctx.from.id);
        let user = await User.findOne({ userId });
        if (!user) user = await User.create({ userId, firstName: ctx.from.first_name });
        
        const diff = Math.floor(Math.abs(new Date() - user.streakStart) / 86400000);
        const stage = getGrowthStage(diff); 
        
        const name = escapeMarkdown(user.firstName || 'User');
        const escapedStage = escapeMarkdown(stage);
        
        const msg = `🔥 *${name}*\n\n📆 Streak: *${diff} Days*\n🌱 Level: *${escapedStage}*\n🏆 Best: ${user.bestStreak}`;
        
        await ctx.reply(msg, {
            parse_mode: 'MarkdownV2',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💔 ወደቅኩ (Relapse)', `rel_${userId}`)],
                [Markup.button.callback('🏆 ደረጃ (Leaderboard)', `led_${userId}`)],
                [Markup.button.callback('🔄 Refresh', `ref_${userId}`)]
            ])
        });
    } catch(e) { console.error("Streak Error:", e); }
}

// --- ACTIVE LEADERBOARD ---
bot.action(/^led_(.+)$/, async ctx => {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const topUsers = await User.find({ lastActive: { $gte: sevenDaysAgo } }).sort({ streakStart: 1 }).limit(10);
        let msg = '🏆 *Top 10 Active Warriors* 🏆\n_\\(Last 7 Days\\)_\n\n';
        if (topUsers.length === 0) msg += "No active users\\.";

        topUsers.forEach((u, i) => {
            const d = Math.floor(Math.abs(new Date() - u.streakStart) / 86400000);
            const cleanName = (u.firstName || 'User').substring(0, 15);
            const name = escapeMarkdown(cleanName);
            msg += `${i+1}\\. ${name} — *${d} days*\n`;
        });
        await ctx.editMessageText(msg, { parse_mode: 'MarkdownV2', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `ref_${ctx.match[1]}`)]]) });
    } catch (e) { ctx.answerCbQuery("Error"); }
});

const verify = (ctx, id) => String(ctx.from.id) === id;
bot.action(/^rel_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); await ctx.editMessageText('አይዞህ! ለምን ወደቅክ?', Markup.inlineKeyboard([[Markup.button.callback('🥱 መሰላቸት', `rsn_bored_${ctx.match[1]}`)], [Markup.button.callback('😰 ጭንቀት', `rsn_stress_${ctx.match[1]}`)], [Markup.button.callback('🔥 ስሜት', `rsn_urg_${ctx.match[1]}`)], [Markup.button.callback('❌ ሰረዝ', `can_${ctx.match[1]}`)]])); });
bot.action(/^rsn_(.+)_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[2])) return ctx.answerCbQuery('Not allowed'); const u = await User.findOne({ userId: ctx.match[2] }); const d = Math.floor(Math.abs(new Date() - u.streakStart)/86400000); if(d>u.bestStreak)u.bestStreak=d; u.streakStart=new Date(); u.relapseHistory.push({reason:ctx.match[1]}); await u.save(); try{await ctx.deleteMessage();}catch(e){} await ctx.reply('✅ Reset. Stay Strong!'); ctx.answerCbQuery(); });
bot.action(/^ref_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); try{await ctx.deleteMessage();}catch(e){} await handleStreak(ctx); ctx.answerCbQuery(); });
bot.action(/^can_(.+)$/, async ctx => { if(!verify(ctx, ctx.match[1])) return ctx.answerCbQuery('Not allowed'); try{await ctx.deleteMessage();}catch(e){} ctx.answerCbQuery(); });

// --- ADMIN PANEL ---
async function showAdminMenu(ctx) {
    const c = await User.countDocuments();
    const p = await Post.countDocuments({ status: 'pending' });
    await ctx.reply(`⚙️ Admin (Users: ${c})`, Markup.inlineKeyboard([
        [Markup.button.callback(`⏳ Pending Posts (${p})`, 'adm_approve')],
        [Markup.button.callback('🔨 Ban User', 'adm_ban'), Markup.button.callback('📝 Start Msg', 'adm_wel')],
        [Markup.button.callback('📢 Channels', 'adm_chan'), Markup.button.callback('🔘 Custom Btn', 'adm_cus')]
    ]));
}

bot.action('adm_ban', async ctx => { await setAdminStep(String(ctx.from.id), 'awaiting_ban_id'); await ctx.reply('ለማገድ (Ban) የሰውን User ID ላክ:'); await ctx.answerCbQuery(); });

bot.action('adm_approve', async ctx => {
    const pendings = await Post.find({ status: 'pending' }).limit(1);
    if (pendings.length === 0) { await ctx.reply('No pending posts.'); return ctx.answerCbQuery(); }
    const p = pendings[0];
    await ctx.reply(`📝 **Request from ${p.userName}**\nUser ID: ${p.userId}\n\n${p.text}`, Markup.inlineKeyboard([[Markup.button.callback('✅ Approve', `app_yes_${p._id}`), Markup.button.callback('❌ Reject', `app_no_${p._id}`)]]));
    await ctx.answerCbQuery();
});
bot.action(/^app_yes_(.+)$/, async ctx => { await Post.findByIdAndUpdate(ctx.match[1], { status: 'approved' }); await ctx.deleteMessage(); await ctx.reply('Approved!'); });
bot.action(/^app_no_(.+)$/, async ctx => { await Post.findByIdAndDelete(ctx.match[1]); await ctx.deleteMessage(); await ctx.reply('Deleted.'); });

const ask = (ctx, s, t) => { setAdminStep(String(ctx.from.id), s); ctx.reply(t); ctx.answerCbQuery(); };
bot.action('adm_wel', c => ask(c, 'awaiting_welcome', 'Msg:'));
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
