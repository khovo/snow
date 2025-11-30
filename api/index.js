const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');

// --- 1. CONFIGURATION (ማስተካከያ) ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;
// Admin IDs: ክፍተት (Space) ካለ እናጠዳለን
const ADMIN_IDS = (process.env.ADMIN_IDS || "").split(',').map(id => id.trim());

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is missing!');
if (!MONGODB_URI) throw new Error('MONGODB_URI is missing!');

// --- 2. DATABASE SCHEMAS (የዳታ አይነቶች) ---

// A. Anti-Duplicate System (ለ 24 ሰዓት የመልእክት ID ይይዛል)
// ይሄ ነው "ሁለቴ መመለስን" የሚያስቆመው
const processedUpdateSchema = new mongoose.Schema({
  update_id: { type: Number, required: true, unique: true },
  createdAt: { type: Date, default: Date.now, expires: 86400 } // 24 hours TTL
});
const ProcessedUpdate = mongoose.models.ProcessedUpdate || mongoose.model('ProcessedUpdate', processedUpdateSchema);

// B. Configs (የቦቱ መቼቶች - Start Msg, Layout...)
const configSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.models.Config || mongoose.model('Config', configSchema);

// C. User & Session (ተጠቃሚዎች እና የአድሚን ማስታወሻ)
const userSchema = new mongoose.Schema({
  userId: { type: String, required: true, unique: true },
  firstName: String,
  // Streak Info
  streakStart: { type: Date, default: Date.now },
  bestStreak: { type: Number, default: 0 },
  relapseHistory: [{ date: { type: Date, default: Date.now }, reason: String }],
  lastActive: { type: Date, default: Date.now },
  // Admin Session (Vercel ቢዘጋም እዚህ እናስታውሳለን)
  adminState: { 
      step: { type: String, default: null }, // e.g. 'awaiting_welcome'
      tempData: { type: mongoose.Schema.Types.Mixed, default: {} }
  }
});
const User = mongoose.models.User || mongoose.model('User', userSchema);

// D. Channels (የሚተዋወቁ ቻናሎች)
const channelSchema = new mongoose.Schema({
  name: { type: String, required: true },
  link: { type: String, required: true }
});
const Channel = mongoose.models.Channel || mongoose.model('Channel', channelSchema);

// E. Custom Buttons (አንተ የፈጠርካቸው በተኖች - Voice ጨምሮ)
const customButtonSchema = new mongoose.Schema({
  label: { type: String, required: true, unique: true },
  type: { type: String, enum: ['text', 'photo', 'video', 'voice'], default: 'text' },
  content: { type: String, required: true },
  caption: { type: String }
});
const CustomButton = mongoose.models.CustomButton || mongoose.model('CustomButton', customButtonSchema);

// F. Motivation (አነቃቂ ፅሁፎች)
const motivationSchema = new mongoose.Schema({
  text: { type: String, required: true },
  addedAt: { type: Date, default: Date.now }
});
const Motivation = mongoose.models.Motivation || mongoose.model('Motivation', motivationSchema);

// --- 3. DATABASE CONNECTION ---
let isConnected = false;
async function connectToDatabase() {
  if (isConnected && mongoose.connection.readyState === 1) return;
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    isConnected = true;
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("MongoDB error:", error);
  }
}

// --- 4. HELPER FUNCTIONS (ረዳት ኮዶች) ---

// የአድሚንን ስቴፕ መዝጋቢ (Save Admin Step)
async function setAdminStep(userId, step, data = {}) {
    await User.findOneAndUpdate(
        { userId }, 
        { adminState: { step, tempData: data } }, 
        { upsert: true }
    );
}

// የአድሚንን ስቴፕ አምጪ (Get Admin Step)
async function getAdminState(userId) {
    const user = await User.findOne({ userId });
    return user ? user.adminState : { step: null, tempData: {} };
}

// የአድሚንን ስቴፕ አጥፊ (Clear Step - ስራ ሲጨርስ)
async function clearAdminStep(userId) {
    await User.findOneAndUpdate(
        { userId }, 
        { adminState: { step: null, tempData: {} } }
    );
}

// Setting አምጪ (Get Config)
async function getConfig(key, defaultValue) {
    const doc = await Config.findOne({ key });
    return doc ? doc.value : defaultValue;
}

// --- 5. BOT LOGIC ---
const bot = new Telegraf(BOT_TOKEN);

// A. START COMMAND
bot.start(async (ctx) => {
  try {
    const userId = String(ctx.from.id);
    const firstName = ctx.from.first_name || 'Friend';
    
    // User መዝግብ / Update አድርግ
    await User.findOneAndUpdate(
        { userId }, 
        { firstName, lastActive: new Date() }, 
        { upsert: true }
    );
    
    // አድሚን ከሆነ የድሮ ስቴፕ አፅዳ (ንፁህ ጅምር እንዲሆን)
    if (ADMIN_IDS.includes(userId)) await clearAdminStep(userId);

    // በተን ስሞችን ከ Database አምጣ (ካልተቀየሩ Default ይውሰድ)
    const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
    const channelLabel = await getConfig('channel_btn_label', '📢 ቻናሎች');
    const streakLabel = await getConfig('streak_btn_label', '📅 ቀኔን ቁጠር');

    // Layout አምጣ
    const defaultLayout = [[urgeLabel, streakLabel], [channelLabel]];
    let layoutRaw = await getConfig('keyboard_layout', defaultLayout);
    let layout = (typeof layoutRaw === 'string') ? JSON.parse(layoutRaw) : layoutRaw;

    // Custom Buttons ጨምር
    const customBtns = await CustomButton.find({});
    const existingLabels = layout.flat();
    let tempRow = [];
    
    customBtns.forEach(btn => {
        if (!existingLabels.includes(btn.label)) {
            tempRow.push(btn.label);
            if (tempRow.length === 2) { 
                layout.push(tempRow); 
                tempRow = []; 
            }
        }
    });
    if (tempRow.length > 0) layout.push(tempRow);

    // Admin Panel በተን (አድሚን ከሆነ ብቻ)
    if (ADMIN_IDS.includes(userId)) {
        layout.push(['🔐 Admin Panel']);
    }

    const welcomeMsg = await getConfig('welcome_msg', `ሰላም ${firstName}! እንኳን በሰላም መጣህ።`);
    await ctx.reply(welcomeMsg, Markup.keyboard(layout).resize());
  } catch (e) {
    console.error("Start Error:", e);
  }
});

// B. MAIN INPUT HANDLER (ሁሉንም ፅሁፍ እና ሚዲያ የሚቀበል)
bot.on(['text', 'photo', 'video', 'voice'], async (ctx) => {
    try {
        const userId = String(ctx.from.id);
        const text = ctx.message.text; // Text ካለ

        // === 1. ADMIN WIZARD CHECK (አድሚን የሆነ ነገር እየጨመረ ነው?) ===
        if (ADMIN_IDS.includes(userId)) {
            const state = await getAdminState(userId);
            
            // ስቴፕ ውስጥ ካለ (ለምሳሌ: ስም እየፃፈ ከሆነ)
            if (state && state.step) {
                // Cancel
                if (text === '/cancel') {
                    await clearAdminStep(userId);
                    return ctx.reply('❌ ሂደቱ ተሰርዟል።');
                }

                // --- Layout ማስተካከያ ---
                if (state.step === 'awaiting_layout') {
                    if (!text) return ctx.reply('እባክዎ ፅሁፍ ይላኩ።');
                    const lines = text.split('\n').map(line => 
                        line.split(',').map(item => item.trim()).filter(i => i !== '')
                    ).filter(row => row.length > 0);
                    
                    await Config.findOneAndUpdate({ key: 'keyboard_layout' }, { value: JSON.stringify(lines) }, { upsert: true });
                    await ctx.reply('✅ Layout በተሳካ ሁኔታ ተቀይሯል! /start ብለው ያረጋግጡ።');
                    await clearAdminStep(userId);
                    return;
                }

                // --- Start Message ---
                if (state.step === 'awaiting_welcome') {
                    await Config.findOneAndUpdate({ key: 'welcome_msg' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ Start Message ተቀይሯል!');
                    await clearAdminStep(userId);
                    return;
                }

                // --- Button Renaming ---
                if (state.step === 'awaiting_urge_name') {
                    await Config.findOneAndUpdate({ key: 'urge_btn_label' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ ተቀይሯል! /start ይበሉ።');
                    await clearAdminStep(userId); return;
                }
                if (state.step === 'awaiting_streak_name') {
                    await Config.findOneAndUpdate({ key: 'streak_btn_label' }, { value: text }, { upsert: true });
                    await ctx.reply('✅ ተቀይሯል! /start ይበሉ።');
                    await clearAdminStep(userId); return;
                }

                // --- Channel Adding ---
                if (state.step === 'awaiting_channel_name') {
                    await setAdminStep(userId, 'awaiting_channel_link', { name: text });
                    return ctx.reply('🔗 አሁን የቻናሉን ሊንክ ይላኩ (https://t.me/...):');
                }
                if (state.step === 'awaiting_channel_link') {
                    await Channel.create({ name: state.tempData.name, link: text });
                    await ctx.reply('✅ ቻናል ተጨምሯል!');
                    await clearAdminStep(userId); return;
                }

                // --- Custom Button Adding ---
                if (state.step === 'awaiting_btn_name') {
                    await setAdminStep(userId, 'awaiting_btn_content', { label: text });
                    return ctx.reply('📥 አሁን ይዘቱን ይላኩ (ፅሁፍ፣ ፎቶ፣ ቪዲዮ ወይም Voice):');
                }
                if (state.step === 'awaiting_btn_content') {
                    let type = 'text';
                    let content = '';
                    let caption = ctx.message.caption || '';

                    if (ctx.message.voice) {
                        type = 'voice';
                        content = ctx.message.voice.file_id;
                    } else if (ctx.message.photo) {
                        type = 'photo';
                        content = ctx.message.photo[ctx.message.photo.length - 1].file_id;
                    } else if (ctx.message.video) {
                        type = 'video';
                        content = ctx.message.video.file_id;
                    } else if (text) {
                        content = text;
                    } else {
                        return ctx.reply('⚠️ እባክዎ ትክክለኛ መረጃ ይላኩ።');
                    }
                    
                    // Check duplicate
                    try {
                        await CustomButton.create({ label: state.tempData.label, type, content, caption });
                        await ctx.reply(`✅ በተን "${state.tempData.label}" ተፈጥሯል! /start ብለው ያዩት።`);
                    } catch (err) {
                        await ctx.reply('❌ ስህተት፡ ምናልባት በዚህ ስም ሌላ በተን ይኖር ይሆናል።');
                    }
                    await clearAdminStep(userId);
                    return;
                }

                // --- Motivation Adding ---
                if (state.step === 'awaiting_motivation') {
                    if (!text) return ctx.reply('ፅሁፍ ብቻ ይላኩ።');
                    await Motivation.create({ text });
                    await ctx.reply('✅ አነቃቂ ፅሁፍ ተጨምሯል።');
                    await clearAdminStep(userId); return;
                }
            }
        }

        // === 2. NORMAL USER INTERACTIONS ===

        // Admin Panel Access
        if (text === '🔐 Admin Panel' && ADMIN_IDS.includes(userId)) {
            return showAdminMenu(ctx);
        }

        const urgeLabel = await getConfig('urge_btn_label', '🆘 እርዳኝ');
        if (text === urgeLabel) {
            const count = await Motivation.countDocuments();
            if (count === 0) return ctx.reply('ለጊዜው መልእክት የለም።');
            const random = Math.floor(Math.random() * count);
            const m = await Motivation.findOne().skip(random);
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
            const btns = channels.map(c => [Markup.button.url(c.name, c.link)]);
            return ctx.reply('የሚከተሉትን ቻናሎች ይቀላቀሉ:', Markup.inlineKeyboard(btns));
        }

        // Custom Buttons Handler
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
        console.error("Main Handler Error:", e);
    }
});

// --- 6. STREAK LOGIC (ከቀናት ጋር) ---
async function handleStreak(ctx) {
    const userId = String(ctx.from.id);
    let user = await User.findOne({ userId });
    
    // User ከሌለ እንፍጠር
    if (!user) {
        user = await User.create({ userId, firstName: ctx.from.first_name });
    }

    const now = new Date();
    const diffTime = Math.abs(now - user.streakStart);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    await ctx.reply(
        `🔥 **የ ${user.firstName} አቋም**\n\n` +
        `📆 Streak: **${diffDays} ቀን**\n` +
        `🏆 Best Streak: ${user.bestStreak} ቀን`,
        Markup.inlineKeyboard([
            [Markup.button.callback('💔 ወደቅኩ (Relapse)', `relapse_${userId}`)],
            [Markup.button.callback('🏆 ደረጃ (Leaderboard)', `leaderboard_${userId}`)],
            [Markup.button.callback('🔄 Refresh', `refresh_${userId}`)]
        ])
    );
}

// --- 7. INLINE BUTTON ACTIONS ---

// መብት ማረጋገጫ (ባለቤቱ ነው የነካው?)
const verifyOwner = (ctx, ownerId) => {
    if (String(ctx.from.id) !== ownerId) {
        ctx.answerCbQuery("⚠️ ይሄ የእርስዎ ሜኑ አይደለም!", { show_alert: true });
        return false;
    }
    return true;
};

// Relapse Menu
bot.action(/^relapse_(.+)$/, async (ctx) => {
    const ownerId = ctx.match[1];
    if (!verifyOwner(ctx, ownerId)) return;

    await ctx.editMessageText(
        'አይዞህ! ለምን እንደወደቅክ ንገረኝ? (ምክንያቱን ማወቅ ለቀጣይ ይረዳሃል)',
        Markup.inlineKeyboard([
            [Markup.button.callback('🥱 መሰላቸት', `reason_boredom_${ownerId}`)],
            [Markup.button.callback('😰 ጭንቀት', `reason_stress_${ownerId}`)],
            [Markup.button.callback('🔥 ስሜት', `reason_urge_${ownerId}`)],
            [Markup.button.callback('❌ ሰረዝ (Cancel)', `cancel_${ownerId}`)]
        ])
    );
});

// Process Reason
bot.action(/^reason_(.+)_(.+)$/, async (ctx) => {
    const reason = ctx.match[1];
    const ownerId = ctx.match[2];
    if (!verifyOwner(ctx, ownerId)) return;

    let user = await User.findOne({ userId: ownerId });
    
    // Update Best Streak
    const now = new Date();
    const diffDays = Math.floor(Math.abs(now - user.streakStart) / (1000 * 60 * 60 * 24));
    if (diffDays > user.bestStreak) user.bestStreak = diffDays;
    
    // Reset
    user.streakStart = new Date();
    user.relapseHistory.push({ reason });
    await user.save();

    // Clean up
    try { await ctx.deleteMessage(); } catch(e) {}
    
    await ctx.reply('✅ መዝግቤያለሁ። ቀናትህ ወደ 0 ተመልሰዋል። ተስፋ አትቁረጥ፣ ጠንክር! 💪');
    await ctx.answerCbQuery();
});

// Refresh Action
bot.action(/^refresh_(.+)$/, async (ctx) => {
    const ownerId = ctx.match[1];
    if (!verifyOwner(ctx, ownerId)) return;

    try { await ctx.deleteMessage(); } catch(e) {} // Delete old
    await handleStreak(ctx); // Send new
    await ctx.answerCbQuery();
});

// Cancel Action
bot.action(/^cancel_(.+)$/, async (ctx) => {
    const ownerId = ctx.match[1];
    if (!verifyOwner(ctx, ownerId)) return;
    try { await ctx.deleteMessage(); } catch(e) {}
    await ctx.answerCbQuery('ተሰርዟል');
});

// Leaderboard Action
bot.action(/^leaderboard_(.+)$/, async (ctx) => {
    // Top 10 users
    const topUsers = await User.find().sort({ streakStart: 1 }).limit(10);
    
    let msg = '🏆 **Top 10 Leaders** 🏆\n\n';
    const now = new Date();

    topUsers.forEach((u, index) => {
        const d = Math.floor(Math.abs(now - u.streakStart) / (1000 * 60 * 60 * 24));
        const name = u.firstName ? u.firstName.substring(0, 15) : 'User';
        msg += `${index + 1}. ${name} — **${d} days**\n`;
    });

    await ctx.editMessageText(msg, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
            [Markup.button.callback('🔙 Back', `refresh_${ctx.match[1]}`)]
        ])
    });
});

// --- 8. ADMIN PANEL MENU ---
async function showAdminMenu(ctx) {
    const userCount = await User.countDocuments();
    
    await ctx.reply(
        `⚙️ **Admin Dashboard**\n👥 Users: ${userCount}`,
        Markup.inlineKeyboard([
            [Markup.button.callback('➕ ፅሁፍ (Motivation)', 'admin_add_motivation')],
            [Markup.button.callback('🔲 Layout አስተካክል', 'admin_layout')],
            [Markup.button.callback('📝 Start Msg', 'admin_welcome'), Markup.button.callback('🏷️ Rename', 'admin_rename')],
            [Markup.button.callback('📢 Channels', 'admin_channels'), Markup.button.callback('🔘 Custom Btn', 'admin_custom')],
            [Markup.button.callback('📊 Users Stats', 'admin_stats')]
        ])
    );
}

// Admin Handlers
bot.action('admin_add_motivation', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_motivation');
    await ctx.reply('አነቃቂ ፅሁፉን ፅፈህ ላክ (ለመሰረዝ /cancel በል):');
    await ctx.answerCbQuery();
});

bot.action('admin_layout', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_layout');
    await ctx.reply('Layout አስተካክል (Comma separated):\nEx: 🆘 Urge, 📅 Streak\n📢 Channel');
    await ctx.answerCbQuery();
});

bot.action('admin_welcome', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_welcome');
    await ctx.reply('አዲሱን Start Message ላክ:');
    await ctx.answerCbQuery();
});

bot.action('admin_rename', async (ctx) => {
    await ctx.reply('የቱን መቀየር ትፈልጋለህ?', Markup.inlineKeyboard([
        [Markup.button.callback('🆘 Emergency', 'rename_urge'), Markup.button.callback('📅 Streak', 'rename_streak')]
    ]));
    await ctx.answerCbQuery();
});
bot.action('rename_urge', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_urge_name');
    await ctx.reply('የ Emergency በተን አዲስ ስም ላክ:');
    await ctx.answerCbQuery();
});
bot.action('rename_streak', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_streak_name');
    await ctx.reply('የ Streak በተን አዲስ ስም ላክ:');
    await ctx.answerCbQuery();
});

// Channels Management
bot.action('admin_channels', async (ctx) => {
    const channels = await Channel.find({});
    let btns = [[Markup.button.callback('➕ Add Channel', 'add_channel')]];
    
    channels.forEach(ch => {
        btns.push([Markup.button.callback(`🗑️ ${ch.name}`, `del_chan_${ch._id}`)]);
    });
    
    await ctx.editMessageText('Channels Management:', Markup.inlineKeyboard(btns));
});
bot.action('add_channel', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_channel_name');
    await ctx.reply('የቻናሉን ስም ላክ:');
    await ctx.answerCbQuery();
});
bot.action(/^del_chan_(.+)$/, async (ctx) => {
    await Channel.findByIdAndDelete(ctx.match[1]);
    await ctx.reply('Deleted.');
    await ctx.answerCbQuery();
});

// Custom Buttons Management
bot.action('admin_custom', async (ctx) => {
    const btns = await CustomButton.find({});
    let markup = [[Markup.button.callback('➕ Add Button', 'add_custom')]];
    
    btns.forEach(b => {
        markup.push([Markup.button.callback(`🗑️ ${b.label}`, `del_btn_${b._id}`)]);
    });
    
    await ctx.editMessageText('Custom Buttons:', Markup.inlineKeyboard(markup));
});
bot.action('add_custom', async (ctx) => {
    await setAdminStep(String(ctx.from.id), 'awaiting_btn_name');
    await ctx.reply('የበተኑን ስም ላክ:');
    await ctx.answerCbQuery();
});
bot.action(/^del_btn_(.+)$/, async (ctx) => {
    await CustomButton.findByIdAndDelete(ctx.match[1]);
    await ctx.reply('Deleted.');
    await ctx.answerCbQuery();
});

// --- 9. SERVERLESS FUNCTION EXPORT (CRITICAL FOR VERCEL) ---
module.exports = async (req, res) => {
    try {
        if (req.method === 'POST') {
            const update = req.body;
            const updateId = update.update_id;

            await connectToDatabase();

            // === DEDUPLICATION LOGIC (የድግግሞሽ መከላከያ) ===
            // ቴሌግራም መልእክት ሲልክ Update ID አብሮ ይልካል።
            // ይህንን ID ዳታቤዝ ላይ እንመዘግባለን።
            // በተመሳሳይ ID ሌላ መልእክት ከመጣ (Double Send)፣ Database Error ይፈጥራል፣ ስራው ይቆማል።
            
            try {
                await ProcessedUpdate.create({ update_id: updateId });
            } catch (err) {
                if (err.code === 11000) {
                    // Code 11000 ማለት "Duplicate Key" ነው
                    console.log(`Duplicate update ignored: ${updateId}`);
                    // ቀጥታ OK መልሰን እንወጣለን፣ ቦቱ ስራውን አይደግምም
                    return res.status(200).send('OK');
                }
                // ሌላ አይነት Error ከሆነ ግን ዝም አንልም
                throw err;
            }

            // አዲስ ከሆነ ብቻ ወደ ቦቱ እንልከዋለን
            await bot.handleUpdate(update);
        }
        
        // ሁሌም 200 OK መመለስ አለብን፣ አለበለዚያ ቴሌግራም ደጋግሞ ይልካል
        res.status(200).send('OK');
    } catch (error) {
        console.error('Error handling update:', error);
        // Error ቢፈጠርም 200 እንመልሳለን (Loop እንዳይፈጠር)
        res.status(200).send('OK');
    }
};
