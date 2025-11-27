import os
import logging
import telebot
from telebot import types
from flask import Flask, request

# ሎግ (Log) ማየት እንድንችል - Vercel Logs ላይ ይታያል
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 1. ቶከኑን ከ Environment Variable ያግኛል
TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')

# ማሻሻያ: ቶከን ከሌለ ኮዱ እንዲቆም እና በግልጽ Error እንዲያሳይ (Fail Fast)
if not TOKEN:
    raise ValueError("No TELEGRAM_BOT_TOKEN found in environment variables! Please check Vercel settings.")

# ቦቱን ማስጀመር
bot = telebot.TeleBot(TOKEN, threaded=False)

app = Flask(__name__)

# --- ዋናው ኪቦርድ (Main Menu) ---
def main_menu_keyboard():
    markup = types.ReplyKeyboardMarkup(row_width=2, resize_keyboard=True)
    btn_sos = types.KeyboardButton("🆘 እርዳኝ (SOS)")
    btn_tips = types.KeyboardButton("🧠 ምክር/ዘዴዎች")
    btn_stories = types.KeyboardButton("💪 የለውጥ ታሪኮች")
    btn_resources = types.KeyboardButton("📚 መርጃዎች")
    btn_ask = types.KeyboardButton("❓ ጥያቄ ለመጠየቅ")
    btn_about = types.KeyboardButton("ℹ️ ስለ ቦቱ")
    markup.add(btn_sos, btn_tips, btn_stories, btn_resources, btn_ask, btn_about)
    return markup

# --- መልእክት አስተናጋጆች (Handlers) ---

@bot.message_handler(commands=['start'])
def send_welcome(message):
    print(f"Start command received from {message.from_user.first_name}") # Debug Print
    welcome_text = (
        f"ሰላም {message.from_user.first_name}! 👋\n\n"
        "ወደ ነጻነት ጉዞ እንኳን በደህና መጡ። ምረጥ 👇"
    )
    try:
        bot.send_message(message.chat.id, welcome_text, reply_markup=main_menu_keyboard())
    except Exception as e:
        print(f"Error sending welcome message: {e}")

@bot.message_handler(func=lambda message: message.text == "🆘 እርዳኝ (SOS)")
def sos_response(message):
    print("SOS button pressed") # Debug Print
    bot.send_message(message.chat.id, "🚨 **ረጋ በል!**\n1. ስልክህን አስቀምጥ።\n2. ፊትህን ታጠብ።\n3. ቤተሰብ ጋር ተቀላቀል።", parse_mode='Markdown')

@bot.message_handler(func=lambda message: message.text == "🧠 ምክር/ዘዴዎች")
def tips_response(message):
    bot.send_message(message.chat.id, "✅ **ዘዴዎች:**\n- ቀስቃሽ ቻናሎችን አስወግድ።\n- ብቻህን አትሁን።")

@bot.message_handler(func=lambda message: message.text == "💪 የለውጥ ታሪኮች")
def stories_response(message):
    bot.send_message(message.chat.id, "ታሪኮች በቅርቡ ይለቀቃሉ...")

@bot.message_handler(func=lambda message: message.text == "📚 መርጃዎች")
def resources_response(message):
    bot.send_message(message.chat.id, "መጽሐፍት በቅርቡ...")

@bot.message_handler(func=lambda message: message.text == "❓ ጥያቄ ለመጠየቅ")
def ask_response(message):
    bot.send_message(message.chat.id, "ጥያቄ ካለዎት አድሚንን ያናግሩ።")

@bot.message_handler(func=lambda message: message.text == "ℹ️ ስለ ቦቱ")
def about_response(message):
    bot.send_message(message.chat.id, "ይህ ቦት በበጎ ፈቃደኞች የተሰራ ነው።")

# --- ወሳኙ ክፍል (Webhook Route) ---
@app.route('/webhook', methods=['POST'])
def webhook():
    # ማሻሻያ: የሚመጣውን መልእክት በግልጽ Print ማድረግ (ለ Debugging)
    try:
        json_string = request.get_data().decode('utf-8')
        print(f"Received Update: {json_string}") # Vercel Log ላይ እንዲታይ
        
        update = telebot.types.Update.de_json(json_string)
        bot.process_new_updates([update])
        return "OK", 200
    except Exception as e:
        print(f"Error in webhook: {e}")
        return "Error", 500

@app.route("/")
def index():
    return "Bot is running! Please ensure Webhook is set to /webhook", 200

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get('PORT', 5000)))
