"""Staff notification module for completed intakes."""
import os
from twilio.rest import Client

# Load from .env
from dotenv import load_dotenv
load_dotenv()

STAFF_ALERT_PHONE = os.getenv('STAFF_ALERT_PHONE') or os.getenv('ATTORNEY_PHONE', '')
STAFF_ALERT_EMAIL = os.getenv('STAFF_ALERT_EMAIL') or os.getenv('ATTORNEY_EMAIL', '')


class Notify:
    """Sends staff notifications."""
    
    def __init__(self):
        self.twilio_sid = os.getenv('TWILIO_ACCOUNT_SID')
        self.twilio_token = os.getenv('TWILIO_AUTH_TOKEN')
        self.twilio_phone = os.getenv('TWILIO_PHONE_NUMBER')
        
        if self.twilio_sid and self.twilio_token and self.twilio_sid != 'placeholder':
            self.client = Client(self.twilio_sid, self.twilio_token)
        else:
            self.client = None
    
    def send_notification(self, summary: str):
        """Send notification to attorney"""
        
        if self.client and self.twilio_phone and STAFF_ALERT_PHONE:
            try:
                message = self.client.messages.create(
                    body=self._sms_alert_body(summary),
                    from_=self.twilio_phone,
                    to=STAFF_ALERT_PHONE
                )
                print(f"Staff alert SMS sent: {message.sid}")
            except Exception as e:
                print(f"Staff alert SMS failed: {e}")
        
        print("\n" + "="*50)
        print("EMAIL REPORT (Simulated)")
        print("="*50)
        print(f"To: {STAFF_ALERT_EMAIL}")
        print("Subject: New Immigration Emergency Intake - Action Required")
        print("-"*50)
        print(summary)
        print("="*50 + "\n")
    
    def send_sms(self, to: str, message: str):
        """Send SMS"""
        if self.client:
            try:
                msg = self.client.messages.create(
                    body=message,
                    from_=self.twilio_phone,
                    to=to
                )
                print(f"SMS sent: {msg.sid}")
            except Exception as e:
                print(f"SMS failed: {e}")
        else:
            print(f"\n[SMS to {to}]: {message}\n")

    def _sms_alert_body(self, summary: str):
        lines = [line.strip() for line in summary.splitlines() if line.strip()]
        priority = next((line for line in lines if 'NEW IMMIGRATION EMERGENCY INTAKE' in line), 'New immigration emergency intake')
        location = next((line for line in lines if line.startswith('Current Location:')), '')
        language = next((line for line in lines if line.startswith('Language:')), '')
        body = '\n'.join([priority, location, language, 'Open the intake dashboard or server logs for details.'])
        return body[:1500]
