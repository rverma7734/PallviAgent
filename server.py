"""
Immigration Intake Agent - Server
Receives SMS webhooks and orchestrates the intake conversation
"""
import os

from flask import Flask, request, jsonify, send_from_directory
from twilio.request_validator import RequestValidator
from twilio.twiml.messaging_response import MessagingResponse
from dotenv import load_dotenv
from conversation_manager import ConversationManager
from ai_processor import AIProcessor
from summary_formatter import SummaryFormatter
from notify import Notify

load_dotenv()

app = Flask(__name__)

conversation_manager = ConversationManager()
ai_processor = AIProcessor()
summary_formatter = SummaryFormatter()
notifier = Notify()

VALIDATE_TWILIO_SIGNATURE = os.getenv('VALIDATE_TWILIO_SIGNATURE', '').lower() == 'true'
PUBLIC_BASE_URL = os.getenv('PUBLIC_BASE_URL', '').rstrip('/')
TWILIO_AUTH_TOKEN = os.getenv('TWILIO_AUTH_TOKEN', '')

DISCLAIMER = """You have reached our emergency immigration intake line. This line collects basic information for staff callback. It is not legal advice and does not create an attorney-client relationship. If someone is in immediate physical danger, call 911.

Reply YES to continue by text, or STOP to opt out."""

COMPLETE_RESPONSE = "Thank you. We sent this intake to the on-call team. Please keep your phone available for a callback. If there is immediate physical danger, call 911."

HELP_RESPONSE = "This line collects immigration intake information for staff callback. Reply STOP to opt out. If someone is in immediate physical danger, call 911."

STOP_RESPONSE = "You have opted out and will not receive further texts from this intake line."


def _twilio_validation_url():
    if not PUBLIC_BASE_URL:
        return request.url
    return f"{PUBLIC_BASE_URL}{request.full_path}".rstrip('?')


def _is_valid_twilio_request():
    if not VALIDATE_TWILIO_SIGNATURE:
        return True
    if not TWILIO_AUTH_TOKEN:
        print("Twilio signature validation enabled but TWILIO_AUTH_TOKEN is missing")
        return False
    signature = request.headers.get('X-Twilio-Signature', '')
    validator = RequestValidator(TWILIO_AUTH_TOKEN)
    return validator.validate(_twilio_validation_url(), request.form, signature)


def _log_intake_debug(sender: str, debug: dict):
    if not debug:
        return
    print(
        "[INTAKE DEBUG] "
        f"sender={sender} "
        f"provider={debug.get('provider')} "
        f"missing_fields={debug.get('missing_fields')} "
        f"selected_next_field={debug.get('selected_next_field')}"
    )


def _log_summary_debug(sender: str, debug: dict):
    if not debug:
        return
    print(
        "[SUMMARY DEBUG] "
        f"sender={sender} "
        f"provider={debug.get('provider')} "
        f"model={debug.get('model')} "
        f"api_configured={debug.get('api_configured')} "
        f"http_status={debug.get('http_status')} "
        f"used_fallback={debug.get('used_fallback')} "
        f"fallback_reason={debug.get('fallback_reason')} "
        f"response_preview={debug.get('response_preview')}"
    )


def process_incoming_message(sender: str, message: str, notify_attorney: bool = True) -> dict:
    normalized_message = message.strip()
    if normalized_message.upper() in {'STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'}:
        conversation_manager.clear_conversation(sender)
        return {
            'response': STOP_RESPONSE,
            'fields': {},
            'intake_complete': False,
            'debug': {'path': 'stop'}
        }

    if normalized_message.upper() in {'HELP', 'INFO'}:
        return {
            'response': HELP_RESPONSE,
            'fields': {},
            'intake_complete': False,
            'debug': {'path': 'help'}
        }

    conversation = conversation_manager.get_or_create(sender)
    is_new_conversation = len(conversation['messages']) == 0

    conversation_manager.add_message(sender, 'client', message)

    if is_new_conversation:
        conversation_manager.add_message(sender, 'assistant', DISCLAIMER)
        updated_conversation = conversation_manager.get_conversation(sender)
        return {
            'response': DISCLAIMER,
            'fields': updated_conversation.get('fields', {}),
            'intake_complete': False,
            'debug': {'path': 'disclaimer_first_message'}
        }

    updated_conversation = conversation_manager.get_conversation(sender)
    result = ai_processor.process(
        messages=updated_conversation['messages'],
        extracted_fields=updated_conversation.get('fields', {})
    )

    _log_intake_debug(sender, result.get('debug'))

    fields = result.get('extracted_fields', {})
    if fields:
        conversation_manager.update_fields(sender, fields)

    final_conversation = conversation_manager.get_conversation(sender)
    intake_complete = result.get('intake_complete', False)
    summary_debug = None
    summary_text = None

    if intake_complete:
        summary_result = summary_formatter.format(
            fields=final_conversation['fields'],
            phone=sender
        )
        summary_text = summary_result['text']
        summary_debug = summary_result.get('debug', {})
        conversation_manager.save_summary(sender, summary_text, summary_debug)
        _log_summary_debug(sender, summary_debug)
        if notify_attorney:
            notifier.send_notification(summary_text)
        conversation_manager.mark_complete(sender)
        response = COMPLETE_RESPONSE
    else:
        response = result.get('next_question', 'Thank you. An attorney will be in touch.')

    conversation_manager.add_message(sender, 'assistant', response)
    final_conversation = conversation_manager.get_conversation(sender)

    return {
        'response': response,
        'fields': final_conversation.get('fields', {}),
        'intake_complete': intake_complete,
        'debug': {
            'intake': result.get('debug', {}),
            'summary': summary_debug,
        },
        'summary_text': summary_text,
    }


@app.route('/sms', methods=['POST'])
def handle_sms():
    if not _is_valid_twilio_request():
        return 'invalid signature', 403

    sender = request.form.get('From', '')
    message = request.form.get('Body', '').strip()

    if not message:
        return '', 200

    print(f"Incoming from {sender}: {message}")
    result = process_incoming_message(sender, message, notify_attorney=True)
    twiml = MessagingResponse()
    twiml.message(result['response'])
    return str(twiml), 200, {'Content-Type': 'application/xml'}


@app.route('/privacy-policy.html', methods=['GET'])
def privacy_policy():
    return send_from_directory(app.root_path, 'privacy-policy.html')


@app.route('/terms.html', methods=['GET'])
def terms():
    return send_from_directory(app.root_path, 'terms.html')


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'})


@app.route('/conversations', methods=['GET'])
def list_conversations():
    return jsonify({'conversations': conversation_manager.list_conversations()})


@app.route('/conversations/<path:phone>', methods=['GET'])
def get_conversation(phone):
    conversation = conversation_manager.get_conversation(phone)
    if not conversation:
        return jsonify({'error': 'conversation not found'}), 404
    return jsonify(conversation)


@app.route('/simulate', methods=['POST'])
def simulate():
    data = request.get_json(silent=True) or {}
    sender = data.get('sender', 'test_client')
    message = (data.get('message') or '').strip()

    if not message:
        return jsonify({'error': 'message is required'}), 400

    print(f"[SIMULATE] From {sender}: {message}")

    if message.upper() == 'CLEAR':
        conversation_manager.clear_conversation(sender)
        return jsonify({
            'response': 'Conversation cleared.',
            'fields': {},
            'intake_complete': False,
            'debug': {'path': 'clear'}
        })

    result = process_incoming_message(sender, message, notify_attorney=False)

    if result['intake_complete'] and result.get('summary_text'):
        print(f"\n{'='*50}")
        print('INTAKE COMPLETE - SUMMARY:')
        print(f"{'='*50}")
        print(result['summary_text'])
        print(f"{'='*50}\n")

    return jsonify(result)


if __name__ == '__main__':
    print('=' * 50)
    print('Immigration Intake Agent - Running')
    print('=' * 50)
    app.run(host='0.0.0.0', port=5005, debug=True)
