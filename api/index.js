const { Telegraf, Markup, session } = require('telegraf');
const mongoose = require('mongoose');

// --- Configuration ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// --- Database Schemas ---

const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// User Schema Updated for Relapse History
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ 
      date: { type: Date, default: Date.now }, 
      reason: String 
  }]
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String }
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// --- DB Connection ---
let isConnected = false;
async function connectToDatabase() {
  if (isConnected) return;
  try {
    await mongoose.connect(MONGODB_URI);
    isConnected = true;
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB connection error:", error);
  }
}

// --- Helper Functions ---
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
};

// --- START Handler ---
bot.start(async (ctx) => {
  await connectToDatabase();
  const userId = String(ctx.from.id);
  const isUserAdmin = ADMIN_IDS.includes(userId);

  const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
  const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
  const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');

  const defaultLayout = [
      [urgeLabel, streakLabel],
      [channelLabel]
  ];

  let layout = await getConfig('keyboard_layout', defaultLayout);
  if (typeof layout === 'string') {
      try { layout = JSON.parse(layout); } catch (e) { layout = defaultLayout; }
  }

  const customBtns = await CustomButton.find({});
  const allLayoutLabels = layout.flat();
  let tempRow = [];
  
  customBtns.forEach(btn => {
      if (!allLayoutLabels.includes(btn.label)) {
          tempRow.push(btn.label);
          if (tempRow.length === 2) {
              layout.push(tempRow);
              tempRow = [];
          }
      }
  });
  if (tempRow.length > 0) layout.push(tempRow);

  if (isUserAdmin) layout.push(['🔐 Admin Panel']);

  const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${ctx.from.first_name}! እንኳን በሰላም መጣህ።`);
  await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
});

// --- MAIN TEXT HANDLER ---
bot.on('text', async (ctx, next) => {
    if (ctx.session && ctx.session.step) return next();
    const text = ctx.message.text;
    await connectToDatabase();

    if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(String(ctx.from.id))) {
        return showAdminMenu(ctx);
    }

    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    if (text === urgeLabel) {
        const count = await Motivation.countDocuments();
        if (count === 0) return ctx.reply('ለጊዜው መልእክት የለም።');
        const random = Math.floor(Math.random() * count);
        const m = await Motivation.findOne().skip(random);
        return ctx.reply(m.text, { parse_mode: 'Markdown' });
    }

    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
    if (text === channelLabel) {
        const channels = await Channel.find({});
        if (channels.length === 0) return ctx.reply('ቻናል የለም።');
        const channelBtns = channels.map(c => [Markup.button.url(c.name, c.link)]);
        return ctx.reply('ይቀላቀሉ:', Markup.inlineKeyboard(channelBtns));
    }

    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
    if (text === streakLabel) {
        return handleStreak(ctx);
    }

    const customBtn = await CustomButton.findOne({ label: text });
    if (customBtn) {
        if (customBtn.type === 'photo') {
            return ctx.replyWithPhoto(customBtn.content, { caption: customBtn.caption });
        } else if (customBtn.type === 'video') {
            return ctx.replyWithVideo(customBtn.content, { caption: customBtn.caption });
        } else {
            return ctx.reply(customBtn.content);
        }
    }

    return next();
});

// --- STREAK & LEADERBOARD LOGIC ---
async function handleStreak(ctx) {
    const userId = String(ctx.from.id);
    let user = await User.findOne({ userId });
    
    if (!user) {
        user = await User.create({ userId, firstName: ctx.from.first_name });
    }

    const now = new Date();
    const diffTime = Math.abs(now - user.streakStart);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    await ctx.reply(
        `🔥 **የአሁን አቋም (Current Streak)**\n\n` +
        `👤 ስም: ${user.firstName}\n` +
        `📆 ቀናት: **${diffDays} ቀን**\n` +
        `🏆 ምርጥ: ${user.bestStreak} ቀን\n\n` +
        `ታማኝነት ለራስ ነው!`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('💔 ወደቅኩ (Relapse)', 'ask_relapse_reason')],
                [Markup.button.callback('🏆 ደረጃ (Leaderboard)', 'view_leaderboard')],
                [Markup.button.callback('🔄 Refresh', 'streak_check')]
            ])
        }
    );
}

// 1. Leaderboard Logic
bot.action('view_leaderboard', async (ctx) => {
    await connectToDatabase();
    // ረጅም ጊዜ የቆዩትን (Start date የራቀውን) 10 ሰዎች ማምጣት
    const topUsers = await User.find().sort({ streakStart: 1 }).limit(10);
    
    let msg = '🏆 **NoFap የጀግኖች ሰንጠረዥ** 🏆\n\n';
    const now = new Date();

    if (topUsers.length === 0) msg = "እስካሁን ማንም አልተመዘገበም።";

    topUsers.forEach((u, index) => {
        const diffTime = Math.abs(now - u.streakStart);
        const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));
        // ስም እንዳይረዝም መቁረጥ
        const name = u.firstName ? u.firstName.substring(0, 15) : 'Unknown';
        
        let medal = '🎗️';
        if (index === 0) medal = '🥇';
        if (index === 1) medal = '🥈';
        if (index === 2) medal = '🥉';

        msg += `${medal} ${index + 1}. **${name}** — ${days} ቀን\n`;
    });

    msg += '\nበርቱ! አንተም ስምህ እዚህ ዝርዝር ውስጥ ይገባል! 💪';
    
    await ctx.reply(msg, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});

// 2. Relapse Logic (Smart Reflection)
bot.action('ask_relapse_reason', async (ctx) => {
    await ctx.reply(
        'አይዞህ! መውደቅ የሽንፈት መጨረሻ አይደለም።\n' + 
        'ግን እስቲ ንገረኝ፣ ለምን ወደቅክ? (ምክንያቱን ማወቅ ለቀጣይ ይጠቅማል)',
        Markup.inlineKeyboard([
            [Markup.button.callback('🥱 መሰላቸት (Boredom)', 'relapse_boredom')],
            [Markup.button.callback('😰 ጭንቀት (Stress)', 'relapse_stress')],
            [Markup.button.callback('📱 Social Media', 'relapse_social')],
            [Markup.button.callback('🔥 ከፍተኛ ስሜት (Urge)', 'relapse_urge')],
            [Markup.button.callback('🤷 ዝም ብሎ', 'relapse_unknown')]
        ])
    );
    await ctx.answerCbQuery();
});

// Handle Reasons
bot.action(/^relapse_(.+)$/, async (ctx) => {
    const reasonCode = ctx.match[1];
    const userId = String(ctx.from.id);
    await connectToDatabase();
    
    let user = await User.findOne({ userId });
    
    // Save Best Streak
    const now = new Date();
    const diffTime = Math.abs(now - user.streakStart);
    const currentDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    if (currentDays > user.bestStreak) user.bestStreak = currentDays;

    // Reset & Save History
    user.streakStart = new Date();
    user.relapseHistory.push({ reason: reasonCode });
    await user.save();

    // Advice based on reason
    let advice = "";
    if (reasonCode === 'boredom') advice = "⚠️ **ምክር:** መሰላቸት ትልቅ ጠላት ነው። ስራ ፈት አትሁን፣ መጽሐፍ አንብብ ወይም ስፖርት ስራ።";
    else if (reasonCode === 'stress') advice = "⚠️ **ምክር:** ጭንቀት ሲኖርህ ወደ ሱስ አትሩጥ። ጓደኛህን አናግር፣ ወይም ወጣ ብለህ ተንፈስ።";
    else if (reasonCode === 'social') advice = "⚠️ **ምክር:** Social Media ላይ Trigger የሚያደርጉህን ነገሮች Unfollow አድርግ። ስልክህን አርቀህ ተኛ።";
    else advice = "⚠️ **ምክር:** ቀጣይ ጊዜ ስሜት ሲመጣብህ የ Emergency በተኑን ተጫን።";

    await ctx.reply(
        `መዝግቤያለሁ። ቀናትህ ወደ 0 ተመልሰዋል።\n\n${advice}\n\nእንደ አዲስ እንጀምር! በርታ!`, 
        { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery();
});

bot.action('streak_check', async (ctx) => {
    await handleStreak(ctx);
    await ctx.answerCbQuery();
});

// --- ADMIN PANEL ---
async function showAdminMenu(ctx) {
    await ctx.reply(
        '⚙️ **Admin Dashboard**',
        Markup.inlineKeyboard([
            [Markup.button.callback('🔲 Layout አስተካክል', 'edit_layout')],
            [Markup.button.callback('📝 Start Msg', 'set_welcome'), Markup.button.callback('🏷️ Rename Btns', 'rename_buttons')],
            [Markup.button.callback('📢 Channels', 'manage_channels'), Markup.button.callback('🔘 Custom Btns', 'manage_custom_btns')],
            [Markup.button.callback('💪 Motivation', 'manage_motivation')]
        ])
    );
}

// ... Admin Handlers (Same as before) ...
bot.action('edit_layout', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_layout_input' };
    const urge = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const chan = await getConfig('channel_btn_label', '📢 ቻናሎች');
    const streak = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');
    await ctx.reply(`Layout አስተካክል (Comma separated):\nEx:\n${urge}, ${streak}\n${chan}`, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();
});
bot.action('rename_buttons', isAdmin, async (ctx) => {
    await ctx.reply('Rename:', Markup.inlineKeyboard([
        [Markup.button.callback('🆘 Emergency', 'rename_urge')],
        [Markup.button.callback('📢 Channels', 'rename_channel')],
        [Markup.button.callback('📅 Streak', 'rename_streak')]
    ]));
    await ctx.answerCbQuery();
});
bot.action('rename_streak', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_streak_label' }; await ctx.reply('New Streak Name:'); await ctx.answerCbQuery();
});
bot.action('rename_urge', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_urge_label' }; await ctx.reply('New Urge Name:'); await ctx.answerCbQuery();
});
bot.action('rename_channel', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_channel_label' }; await ctx.reply('New Channel Name:'); await ctx.answerCbQuery();
});
bot.action('set_welcome', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_welcome_msg' }; await ctx.reply('New Start Msg:'); await ctx.answerCbQuery();
});
bot.action('manage_channels', isAdmin, async (ctx) => {
    await connectToDatabase();
    const channels = await Channel.find({});
    let buttons = [[Markup.button.callback('➕ Add', 'add_channel')]];
    channels.forEach(c => buttons.push([Markup.button.callback(`🗑️ Del ${c.name}`, `del_chan_${c._id}`)]));
    await ctx.reply('Channels:', Markup.inlineKeyboard(buttons)); await ctx.answerCbQuery();
});
bot.action('add_channel', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_channel_name' }; await ctx.reply('Name:'); await ctx.answerCbQuery();
});
bot.action(/^del_chan_(.+)$/, isAdmin, async (ctx) => {
    await connectToDatabase(); await Channel.findByIdAndDelete(ctx.match[1]); await ctx.reply('Deleted.'); await ctx.answerCbQuery();
});
bot.action('manage_custom_btns', isAdmin, async (ctx) => {
    await connectToDatabase();
    const btns = await CustomButton.find({});
    let buttons = [[Markup.button.callback('➕ Add', 'add_custom_btn')]];
    btns.forEach(b => buttons.push([Markup.button.callback(`🗑️ Del ${b.label}`, `del_btn_${b._id}`)]));
    await ctx.reply('Custom Buttons:', Markup.inlineKeyboard(buttons)); await ctx.answerCbQuery();
});
bot.action('add_custom_btn', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_btn_label' }; await ctx.reply('Btn Name:'); await ctx.answerCbQuery();
});
bot.action(/^del_btn_(.+)$/, isAdmin, async (ctx) => {
    await connectToDatabase(); await CustomButton.findByIdAndDelete(ctx.match[1]); await ctx.reply('Deleted.'); await ctx.answerCbQuery();
});
bot.action('manage_motivation', isAdmin, async (ctx) => {
    ctx.session = { step: 'awaiting_motivation' }; await ctx.reply('Send Motivation:'); await ctx.answerCbQuery();
});

// --- WIZARD HANDLER ---
bot.on(['text', 'photo', 'video'], async (ctx) => {
    if (!ctx.session || !ctx.session.step) return;
    if (ctx.message.text === '/cancel') { ctx.session = null; return ctx.reply('Cancelled.'); }
    const step = ctx.session.step;
    await connectToDatabase();

    if (step === 'awaiting_layout_input') {
        const rawLines = ctx.message.text.split('\n');
        const newLayout = rawLines.map(line => line.split(',').map(item => item.trim()).filter(i => i !== '')).filter(r => r.length > 0);
        await setConfig('keyboard_layout', JSON.stringify(newLayout));
        await ctx.reply('Layout Updated!'); ctx.session = null;
    }
    else if (step === 'awaiting_welcome_msg') { await setConfig('welcome_msg', ctx.message.text); await ctx.reply('Saved.'); ctx.session = null; }
    else if (step === 'awaiting_urge_label') { await setConfig('urge_btn_label', ctx.message.text); await ctx.reply('Saved.'); ctx.session = null; }
    else if (step === 'awaiting_channel_label') { await setConfig('channel_btn_label', ctx.message.text); await ctx.reply('Saved.'); ctx.session = null; }
    else if (step === 'awaiting_streak_label') { await setConfig('streak_btn_label', ctx.message.text); await ctx.reply('Saved.'); ctx.session = null; }
    
    else if (step === 'awaiting_channel_name') { ctx.session.temp_channel_name = ctx.message.text; ctx.session.step = 'awaiting_channel_link'; await ctx.reply('Link:'); }
    else if (step === 'awaiting_channel_link') { await Channel.create({ name: ctx.session.temp_channel_name, link: ctx.message.text }); await ctx.reply('Done.'); ctx.session = null; }
    
    else if (step === 'awaiting_btn_label') { ctx.session.temp_btn_label = ctx.message.text; ctx.session.step = 'awaiting_btn_content'; await ctx.reply('Content:'); }
    else if (step === 'awaiting_btn_content') {
        const label = ctx.session.temp_btn_label;
        let type = 'text', content = '', caption = ctx.message.caption || '';
        if (ctx.message.photo) { type = 'photo'; content = ctx.message.photo[ctx.message.photo.length - 1].file_id; }
        else if (ctx.message.video) { type = 'video'; content = ctx.message.video.file_id; }
        else if (ctx.message.text) { content = ctx.message.text; }
        else return ctx.reply('Invalid.');
        await CustomButton.create({ label, type, content, caption }); await ctx.reply('Done.'); ctx.session = null;
    }
    else if (step === 'awaiting_motivation') { await Motivation.create({ text: ctx.message.text }); await ctx.reply('Done.'); ctx.session = null; }
});

module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') { await bot.handleUpdate(req.body); res.status(200).json({ message: 'OK' }); }
        else { res.status(200).json({ message: 'Bot is active' }); }
    } catch (error) { console.error(error); res.status(500).json({ error: 'Internal Server Error' }); }
};
