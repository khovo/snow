const { Telegraf } = require('telegraf');

// ቦቱ ሚስጥራዊ ቁልፎቹን (Keys) ካላገኘ ስህተት እንዳያመጣ መከላከያ
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN must be provided!');
}

const bot = new Telegraf(BOT_TOKEN);

// ቦቱ ሲጀምር የሚሰጠው መልስ
bot.start((ctx) => {
    ctx.reply('ሰላም! ቦቱ Vercel ላይ በትክክል ተጭኗል። አሁን ወደ ቀጣዩ Step መሄድ እንችላለን።');
});

// ለ Vercel Webhook ማስተካከያ
module.exports = async (req, res) => {
    try {
        // የቴሌግራምን መልእክት ተቀብሎ ማስተናገድ
        if (req.method === 'POST') {
            await bot.handleUpdate(req.body);
            res.status(200).json({ message: 'OK' });
        } else {
            res.status(200).json({ message: 'Bot is running correctly!' });
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};
