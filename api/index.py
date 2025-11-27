import os
import logging
import telebot
from telebot import types
from flask import Flask, request

# ሎግ (Log) ማየት እንድንችል
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ቶከኑን ከ Environment Variable ያግኛል
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')

# ቶከን ከሌለ ለጊዜው ኮዱ እንዳይበላሽ ባዶ እሴት እንሰጠዋለን (ግን ቦቱ አይሰራም)
if not TOKEN:
    logger.error("Error: TELEGRAM_BOT_TOKEN not found in environment variables!")
    bot = None
else:
    bot = telebot.TeleBot(TOKEN, threaded=False)

app = Flask(__name__)

# --- ዋናው ኪቦርድ (Main Menu) ---
def main_menu_keyboard():
    markup = types.ReplyKeyboardMarkup(row_width=2, resize_keyboard=True)
    
    # አዝራሮች (Buttons)
    btn_sos = types.KeyboardButton("🆘 እርዳኝ (SOS)")
    btn_tips = types.KeyboardButton("🧠 ምክር/ዘዴዎች")
    btn_stories = types.KeyboardButton("💪 የለውጥ ታሪኮች")
    btn_resources = types.KeyboardButton("📚 መርጃዎች")
    btn_ask = types.KeyboardButton("❓ ጥያቄ ለመጠየቅ")
    btn_about = types.KeyboardButton("ℹ️ ስለ ቦቱ")
    
    markup.add(btn_sos, btn_tips, btn_stories, btn_resources, btn_ask, btn_about)
    return markup

# --- መልእክት አስተናጋጆች (Handlers) ---

if bot:
    @bot.message_handler(commands=['start'])
    def send_welcome(message):
        try:
            welcome_text = (
                f"ሰላም {message.from_user.first_name}! 👋\n\n"
                "ወደ ነጻነት ጉዞ እንኳን በደህና መጡ። "
                "ይህ ቦት ከፖርኖግራፊ ሱስ ለመውጣት በሚያደርጉት ጉዞ አጋዥ ነው።\n\n"
                "ከታች ካሉት አማራጮች ይምረጡ 👇"
            )
            bot.send_message(message.chat.id, welcome_text, reply_markup=main_menu_keyboard())
        except Exception as e:
            logger.error(f"Error in start command: {e}")

    # 1. እርዳኝ (SOS)
    @bot.message_handler(func=lambda message: message.text == "🆘 እርዳኝ (SOS)")
    def sos_response(message):
        try:
            sos_text = (
                "🚨 **ረጋ በል!** ስሜቱ ጊዜያዊ ነው።\n\n"
                "1. ስልክህን አሁን አስቀምጥና ከክፍሉ ውጣ።\n"
                "2. ቀዝቃዛ ውሃ ፊትህን ታጠብ።\n"
                "3. ለጓደኛህ ወይም ለቤተሰብ ደውል አውራ።\n"
                "4. 10 ጊዜ በጥልቀት ተንፍስ።"
            )
            bot.send_message(message.chat.id, sos_text, parse_mode='Markdown')
        except Exception as e:
            logger.error(f"Error in SOS: {e}")

    # 2. ምክር እና ዘዴዎች
    @bot.message_handler(func=lambda message: message.text == "🧠 ምክር/ዘዴዎች")
    def tips_response(message):
        bot.send_message(message.chat.id, "✅ **ሱስን ለማሸነፍ:**\n1. ቀስቃሽ ነገሮችን አስወግድ።\n2. ጊዜህን በስራ ሙላ።")

    # 3. የለውጥ ታሪኮች
    @bot.message_handler(func=lambda message: message.text == "💪 የለውጥ ታሪኮች")
    def stories_response(message):
        bot.send_message(message.chat.id, "አንድ ወጣት፡ 'ስልኬን ማታ ከእኔ ማራቅ ስጀምር ለውጥ አየሁ።'")

    # 4. መርጃዎች
    @bot.message_handler(func=lambda message: message.text == "📚 መርጃዎች")
    def resources_response(message):
        bot.send_message(message.chat.id, "መጽሐፍት በቅርቡ ይጫናሉ።")

    # 5. ጥያቄ
    @bot.message_handler(func=lambda message: message.text == "❓ ጥያቄ ለመጠየቅ")
    def ask_response(message):
        bot.send_message(message.chat.id, "ጥያቄ ካለዎት አድሚንን ያናግሩ።")

    # 6. ስለ ቦቱ
    @bot.message_handler(func=lambda message: message.text == "ℹ️ ስለ ቦቱ")
    def about_response(message):
        bot.send_message(message.chat.id, "ይህ ቦት በበጎ ፈቃደኞች የተሰራ ነው።")


# --- Webhook Route ---
@app.route('/' + (TOKEN if TOKEN else 'webhook'), methods=['POST'])
def getMessage():
    if not bot:
        return "Bot token not configured", 500
    try:
        json_string = request.get_data().decode('utf-8')
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return "!", 200
    except Exception as e:
        logger.error(f"Error processing update: {e}")
        return "Error", 500

@app.route("/")
def webhook():
    if not bot:
        return "Error: TELEGRAM_BOT_TOKEN not set in Vercel Environment Variables.", 500
    
    # ቦቱ እየሰራ መሆኑን ለማረጋገጥ
    try:
        # Webhook መረጃን ማየት ከፈለግን (Optional)
        webhook_info = bot.get_webhook_info()
        return f"Bot is running! Webhook URL: {webhook_info.url}", 200
    except Exception as e:
        return f"Bot is running, but failed to get info: {e}", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get('PORT', 5000)))
