const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
// ክፍተት (Space) ካለ አጥርቶ የሚቀበል
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// --- Database Schemas ---

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
  relapseHistory: [{ 
      date: { type: Date, default: Date.now }, 
      reason: String 
  }],
  lastActive: { type: Date, default: Date.now }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

// Updated to support 'voice'
const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String }
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// --- DB Connection (Robust) ---
let isConnected = false;
async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // Fail fast if DB is down
    });
    isConnected = true;
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    throw new Error("Database Connection Failed");
  }
}

// --- Helper Functions (Added Back) ---
async function getConfig(key, defaultValue) {
    const doc = await Config.findOne({ key });
    return doc ? doc.value : defaultValue;
}

async function setConfig(key, value) {
    await Config.findOneAndUpdate({ key }, { value }, { upsert: true, new: true });
}

// --- Bot Setup ---
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

const isAdmin = (ctx, next) => {
  const userId = String(ctx.from.id);
  if (ADMIN_IDS.includes(userId)) return next();
  // Silently ignore non-admins in admin routes
};

// --- START Handler ---
bot.start(async (ctx) => {
  try {
    await connectToDatabase();
    
    // Track User
    const userId = String(ctx.from.id);
    await User.findOneAndUpdate(
        { userId }, 
        { firstName: ctx.from.first_name, lastActive: new Date() }, 
        { upsert: true }
    );

    const isUserAdmin = ADMIN_IDS.includes(userId);

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');

    const defaultLayout = [[urgeLabel, streakLabel], [channelLabel]];
    let layout = await getConfig('keyboard_layout', defaultLayout);
    if (typeof layout === 'string') {
        try { layout = JSON.parse(layout); } catch (e) { layout = defaultLayout; }
    }

    // Add Custom Buttons
    const customBtns = await CustomButton.find({});
    const allLayoutLabels = layout.flat();
    let tempRow = [];
    customBtns.forEach(btn => {
        if (!allLayoutLabels.includes(btn.label)) {
            tempRow.push(btn.label);
            if (tempRow.length === 2) { layout.push(tempRow); tempRow = []; }
        }
    });
    if (tempRow.length > 0) layout.push(tempRow);

    if (isUserAdmin) layout.push(['🔐 Admin Panel']);

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${ctx.from.first_name}! እንኳን በሰላም መጣህ።`);
    await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
  } catch (e) {
    console.error(e);
    ctx.reply("ትንሽ ችግር አጋጥሟል፣ እባክዎ እንደገና ይሞክሩ።");
  }
});

// --- MAIN TEXT HANDLER ---
bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.step) return next();
    
    try {
        await connectToDatabase();
        const text = ctx.message.text;

        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(String(ctx.from.id))) {
            return showAdminMenu(ctx);
        }

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('ለጊዜው መልእክት የለም።');
            const random = Math.floor(Math.random() * count);
            const m = await Motivation.findOne().skip(random);
            // Delete command message to keep group clean? No, usually we keep user text.
            return ctx.reply(`💪 **በርታ!**\n\n${m.text}`, { parse_mode: 'Markdown' });
        }

        const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
        if (text === streakLabel) {
            return handleStreak(ctx);
        }

        const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
        if (text === channelLabel) {
            const channels = await Channel.find({});
            if (channels.length === 0) return ctx.reply('ቻናል የለም።');
            const channelBtns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return ctx.reply('ይቀላቀሉ:', Markup.inlineKeyboard(channelBtns));
        }

        // Custom Buttons (Text, Photo, Video, Voice)
        const customBtn = await CustomButton.findOne({ label: text });
        if (customBtn) {
            if (customBtn.type === 'photo') {
                return ctx.replyWithPhoto(customBtn.content, { caption: customBtn.caption });
            } else if (customBtn.type === 'video') {
                return ctx.replyWithVideo(customBtn.content, { caption: customBtn.caption });
            } else if (customBtn.type === 'voice') {
                return ctx.replyWithVoice(customBtn.content, { caption: customBtn.caption });
            } else {
                return ctx.reply(customBtn.content);
            }
        }
    } catch (e) {
        console.error(e);
    }
    return next();
});

// --- SECURE STREAK LOGIC (Anti-Crash/Anti-Hijack) ---
async function handleStreak(ctx) {
    const userId = String(ctx.from.id);
    let user = await User.findOne({ userId });
    if (!user) user = await User.create({ userId, firstName: ctx.from.first_name });

    const now = new Date();
    const diffDays = Math.floor(Math.abs(now - user.streakStart) / (1000 * 60 * 60 * 24));

    // IDን አብረን እንልካለን (userId)። ይሄ በተን ለዚህ ሰው ብቻ እንዲሰራ ያደርገዋል።
    await ctx.reply(
        `🔥 **የ ${user.firstName} አቋም**\n` +
        `📆 Streak: **${diffDays} ቀን**\n` +
        `🏆 Best: ${user.bestStreak} ቀን`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💔 ወደቅኩ (Relapse)', `ask_relapse_${userId}`)],
                [Markup.button.callback('🏆 ደረጃ (Leaderboard)', `view_leader_${userId}`)],
                [Markup.button.callback('🔄 Refresh', `refresh_${userId}`)]
            ])
        }
    );
}

// Check if the clicker is the owner of the menu
const isOwner = (ctx, ownerId) => {
    if (String(ctx.from.id) !== ownerId) {
        ctx.answerCbQuery("⚠️ ይሄ የእርስዎ ሜኑ አይደለም!", { show_alert: true });
        return false;
    }
    return true;
};

// 1. Ask Relapse Reason (With Safety Check)
bot.action(/^ask_relapse_(.+)$/, async (ctx) => {
    const ownerId = ctx.match[1];
    if (!isOwner(ctx, ownerId)) return;

    // Edit the message (Don't create new one) - Cleans up previous buttons
    await ctx.editMessageText(
        'አይዞህ! ለምን እንደወደቅክ ንገረኝ? (ምክንያቱን መምረጥህ ለቀጣይ ይረዳሃል)',
        Markup.inlineKeyboard([
            [Markup.button.callback('🥱 መሰላቸት', `reason_boredom_${ownerId}`)],
            [Markup.button.callback('😰 ጭንቀት', `reason_stress_${ownerId}`)],
            [Markup.button.callback('📱 Social Media', `reason_social_${ownerId}`)],
            [Markup.button.callback('🔥 ከፍተኛ ስሜት', `reason_urge_${ownerId}`)],
            [Markup.button.callback('❌ ሰረዝ (Cancel)', `cancel_${ownerId}`)]
        ])
    );
});

// 2. Process Relapse & Auto-Delete
bot.action(/^reason_(.+)_(.+)$/, async (ctx) => {
    const reason = ctx.match[1];
    const ownerId = ctx.match[2];
    if (!isOwner(ctx, ownerId)) return;

    await connectToDatabase();
    let user = await User.findOne({ userId: ownerId });
    
    // Update Stats
    const currentDays = Math.floor(Math.abs(new Date() - user.streakStart) / (1000 * 60 * 60 * 24));
    if (currentDays > user.bestStreak) user.bestStreak = currentDays;
    
    user.streakStart = new Date();
    user.relapseHistory.push({ reason });
    await user.save();

    let advice = "ቀጣይ ጊዜ ጠንከር በል!";
    if (reason === 'boredom') advice = "ስራ ፈት አትሁን፣ መጽሐፍ አንብብ።";
    else if (reason === 'stress') advice = "ጭንቀት ሲኖርህ ጓደኛህን አናግር።";
    else if (reason === 'social') advice = "Social Media አጠቃቀምህን ቀንስ።";

    // CLEAN UP: Delete the menu button message to keep chat clean
    try {
        await ctx.deleteMessage(); 
    } catch (e) {
        // If delete fails (msg too old), just edit it
        await ctx.editMessageText(`✅ መዝግቤያለሁ።\n\n${advice}\n\nቀናትህ ወደ 0 ተመልሰዋል። በርታ!`);
        return;
    }
    
    // Send a fresh confirmation/advice (Optional, or just rely on the edited text above. 
    // Here we prefer deleting the menu and sending a clean short text)
    await ctx.reply(`✅ **${user.firstName}**፣ መዝግቤያለሁ።\n\nምክር: ${advice}\n\nአዲስ ጅምር!`, { parse_mode: 'Markdown' });
});

// 3. Cancel Action (Clean Up)
bot.action(/^cancel_(.+)$/, async (ctx) => {
    if (!isOwner(ctx, ctx.match[1])) return;
    try { await ctx.deleteMessage(); } catch (e) {}
    await ctx.answerCbQuery('ተሰርዟል');
});

// 4. Leaderboard (Auto-Delete/Update)
bot.action(/^view_leader_(.+)$/, async (ctx) => {
    // Leaderboard is public info, maybe allow anyone? 
    // But to prevent spam, let's lock it or just edit the message.
    // Let's Edit.
    
    await connectToDatabase();
    const topUsers = await User.find().sort({ streakStart: 1 }).limit(10);
    let msg = '🏆 **Top 10 Leaders** 🏆\n\n';
    const now = new Date();

    topUsers.forEach((u, i) => {
        const d = Math.floor(Math.abs(now - u.streakStart) / (1000 * 60 * 60 * 24));
        const name = u.firstName ? u.firstName.substring(0, 10) : 'User';
        msg += `${i+1}. ${name} - ${d} days\n`;
    });

    // Add a "Back" button to return to personal stats
    await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', `refresh_${ctx.match[1]}`)]])
    });
});

// 5. Refresh (Back to Stats)
bot.action(/^refresh_(.+)$/, async (ctx) => {
    if (!isOwner(ctx, ctx.match[1])) return;
    
    await connectToDatabase();
    const user = await User.findOne({ userId: ctx.match[1] });
    const d = Math.floor(Math.abs(new Date() - user.streakStart) / (1000 * 60 * 60 * 24));
    
    await ctx.editMessageText(
        `🔥 **የ ${user.firstName} አቋም**\n` +
        `📆 Streak: **${d} ቀን**\n` +
        `🏆 Best: ${user.bestStreak} ቀን`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💔 ወደቅኩ (Relapse)', `ask_relapse_${user.userId}`)],
                [Markup.button.callback('🏆 ደረጃ (Leaderboard)', `view_leader_${user.userId}`)],
                [Markup.button.callback('🔄 Refresh', `refresh_${user.userId}`)]
            ])
        }
    );
});


// --- ADMIN PANEL ---
async function showAdminMenu(ctx) {
    // Count users for the button label
    const userCount = await User.countDocuments();
    
    await ctx.reply(
        '⚙️ **Admin Dashboard**',
        Markup.inlineKeyboard([
            [Markup.button.callback(`👥 Users (${userCount})`, 'view_user_stats')],
            [Markup.button.callback('🔲 Layout', 'edit_layout')],
            [Markup.button.callback('📝 Start Msg', 'set_welcome'), Markup.button.callback('🏷️ Rename', 'rename_buttons')],
            [Markup.button.callback('📢 Channels', 'manage_channels'), Markup.button.callback('🔘 Custom', 'manage_custom_btns')],
            [Markup.button.callback('💪 Motivation', 'manage_motivation')]
        ])
    );
}

// User Stats Viewer
bot.action('view_user_stats', isAdmin, async (ctx) => {
    await connectToDatabase();
    const total = await User.countDocuments();
    // Active users (updated streak in last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const active = await User.countDocuments({ lastActive: { $gte: sevenDaysAgo } });
    
    await ctx.reply(
        `📊 **ስታቲስቲክስ (Statistics)**\n\n` +
        `👥 አጠቃላይ ተጠቃሚ: **${total}**\n` +
        `🔥 ንቁ ተጠቃሚዎች (በ7 ቀን): **${active}**`,
        Markup.inlineKeyboard([[Markup.button.callback('🔙 Back', 'admin_home')]])
    );
    await ctx.answerCbQuery();
});

bot.action('admin_home', isAdmin, async (ctx) => {
    await ctx.deleteMessage(); // Clean up old menu
    await showAdminMenu(ctx);
});

// ... Existing Admin Handlers (Shortened for brevity but functionally same) ...
bot.action('edit_layout', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_layout_input' }; await ctx.reply('Send Layout (Comma separated):'); await ctx.answerCbQuery(); });
bot.action('rename_buttons', isAdmin, async (ctx) => { await ctx.reply('Choose:', Markup.inlineKeyboard([[Markup.button.callback('🆘 Urge', 'rename_urge'), Markup.button.callback('📅 Streak', 'rename_streak')]])); await ctx.answerCbQuery(); });
bot.action('rename_urge', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_urge_label' }; await ctx.reply('New Name:'); await ctx.answerCbQuery(); });
bot.action('rename_streak', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_streak_label' }; await ctx.reply('New Name:'); await ctx.answerCbQuery(); });
bot.action('set_welcome', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_welcome_msg' }; await ctx.reply('New Msg:'); await ctx.answerCbQuery(); });
bot.action('manage_channels', isAdmin, async (ctx) => { await connectToDatabase(); const c = await Channel.find({}); let b = [[Markup.button.callback('➕ Add', 'add_channel')]]; c.forEach(x => b.push([Markup.button.callback(`🗑️ ${x.name}`, `del_chan_${x._id}`)])); await ctx.reply('Channels:', Markup.inlineKeyboard(b)); await ctx.answerCbQuery(); });
bot.action('add_channel', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_channel_name' }; await ctx.reply('Name:'); await ctx.answerCbQuery(); });
bot.action(/^del_chan_(.+)$/, isAdmin, async (ctx) => { await Channel.findByIdAndDelete(ctx.match[1]); await ctx.reply('Deleted'); await ctx.answerCbQuery(); });
bot.action('manage_motivation', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_motivation' }; await ctx.reply('Send Text:'); await ctx.answerCbQuery(); });

// Custom Buttons Manager
bot.action('manage_custom_btns', isAdmin, async (ctx) => { 
    await connectToDatabase(); 
    const b = await CustomButton.find({}); 
    let btns = [[Markup.button.callback('➕ Add', 'add_custom_btn')]]; 
    b.forEach(x => btns.push([Markup.button.callback(`🗑️ ${x.label}`, `del_btn_${x._id}`)])); 
    await ctx.reply('Custom Buttons:', Markup.inlineKeyboard(btns)); 
    await ctx.answerCbQuery(); 
});
bot.action('add_custom_btn', isAdmin, async (ctx) => { ctx.session = { step: 'awaiting_btn_label' }; await ctx.reply('Button Name:'); await ctx.answerCbQuery(); });
bot.action(/^del_btn_(.+)$/, isAdmin, async (ctx) => { await CustomButton.findByIdAndDelete(ctx.match[1]); await ctx.reply('Deleted'); await ctx.answerCbQuery(); });


// --- WIZARD HANDLER (Updated for Voice) ---
bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    if (!ctx.session || !ctx.session.step) return;
    if (ctx.message.text === '/cancel') { ctx.session = null; return ctx.reply('Cancelled.'); }
    
    const step = ctx.session.step;
    await connectToDatabase();

    // ... Layout & Settings handlers (Same as before) ...
    if (step === 'awaiting_layout_input') {
        const rawLines = ctx.message.text.split('\n');
        const newLayout = rawLines.map(line => line.split(',').map(item => item.trim()).filter(i => i !== '')).filter(r => r.length > 0);
        await Config.findOneAndUpdate({ key: 'keyboard_layout' }, { value: JSON.stringify(newLayout) }, { upsert: true });
        await ctx.reply('Layout Updated!'); ctx.session = null;
    }
    else if (step === 'awaiting_welcome_msg') { await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: ctx.message.text }, { upsert: true }); ctx.session = null; await ctx.reply('Saved'); }
    else if (step === 'awaiting_urge_label') { await Config.findOneAndUpdate({ key: 'urge_btn_label' }, { value: ctx.message.text }, { upsert: true }); ctx.session = null; await ctx.reply('Saved'); }
    else if (step === 'awaiting_streak_label') { await Config.findOneAndUpdate({ key: 'streak_btn_label' }, { value: ctx.message.text }, { upsert: true }); ctx.session = null; await ctx.reply('Saved'); }
    
    else if (step === 'awaiting_channel_name') { ctx.session.temp_channel_name = ctx.message.text; ctx.session.step = 'awaiting_channel_link'; await ctx.reply('Link:'); }
    else if (step === 'awaiting_channel_link') { await Channel.create({ name: ctx.session.temp_channel_name, link: ctx.message.text }); await ctx.reply('Added'); ctx.session = null; }

    else if (step === 'awaiting_motivation') { await Motivation.create({ text: ctx.message.text }); await ctx.reply('Added'); ctx.session = null; }

    // Custom Button Content (Updated for Voice)
    else if (step === 'awaiting_btn_label') { ctx.session.temp_btn_label = ctx.message.text; ctx.session.step = 'awaiting_btn_content'; await ctx.reply('Send Content (Text, Photo, Video, or Voice):'); }
    else if (step === 'awaiting_btn_content') {
        const label = ctx.session.temp_btn_label;
        let type = 'text', content = '', caption = ctx.message.caption || '';
        
        if (ctx.message.voice) {
            type = 'voice';
            content = ctx.message.voice.file_id;
        } else if (ctx.message.photo) {
            type = 'photo';
            content = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        } else if (ctx.message.video) {
            type = 'video';
            content = ctx.message.video.file_id;
        } else if (ctx.message.text) {
            content = ctx.message.text;
        } else {
            return ctx.reply('Invalid content. Send text or media.');
        }

        await CustomButton.create({ label, type, content, caption });
        await ctx.reply(`✅ Button "${label}" Created!`);
        ctx.session = null;
    }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') { await bot.handleUpdate(req.body); res.status(200).json({ message: 'OK' }); }
        else { res.status(200).json({ message: 'Active' }); }
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error' }); }
};
