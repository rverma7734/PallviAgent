"""
Attorney Notification Module
Sends intake summary to attorney via SMS and email
"""
import os
from twilio.rest import Client

# Load from .env
from dotenv import load_dotenv
load_dotenv()

ATTORNEY_PHONE = os.getenv('ATTORNEY_PHONE', '')
ATTORNEY_EMAIL = os.getenv('ATTORNEY_EMAIL', '')


class Notify:
    """Sends notifications to attorney"""
    
    def __init__(self):
        self.twilio_sid = os.getenv('TWILIO_ACCOUNT_SID')
        self.twilio_token = os.getenv('TWILIO_AUTH_TOKEN')
        self.twilio_phone = os.getenv('TWILIO_PHONE_NUMBER')
        
        # Initialize Twilio client if configured
        if self.twilio_sid and self.twilio_token and self.twilio_sid != 'placeholder':
            self.client = Client(self.twilio_sid, self.twilio_token)
        else:
            self.client = None
    
    def send_notification(self, summary: str):
        """Send notification to attorney"""
        
        # Try to send SMS via Twilio
        if self.client and self.twilio_phone:
            try:
                message = self.client.messages.create(
                    body="📋 New Immigration Intake Received\n\nCheck email for details.",
                    from_=self.twilio_phone,
                    to=ATTORNEY_PHONE
                )
                print(f"✅ SMS sent: {message.sid}")
            except Exception as e:
                print(f"❌ SMS failed: {e}")
        
        # Print summary to console
        print("\n" + "="*50)
        print("📧 EMAIL REPORT (Simulated)")
        print("="*50)
        print(f"To: {ATTORNEY_EMAIL}")
        print("Subject: New Immigration Intake - Action Required")
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
                print(f"✅ SMS sent: {msg.sid}")
            except Exception as e:
                print(f"❌ SMS failed: {e}")
        else:
            print(f"\n[SMS to {to}]: {message}\n")
