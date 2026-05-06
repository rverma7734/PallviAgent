"""Attorney-facing emergency intake summary formatter."""
import os
import requests
from dotenv import load_dotenv

load_dotenv()


class SummaryFormatter:
    """Format intake data into attorney summary"""

    def __init__(self):
        self.api_key = os.getenv('GEMINI_API_KEY')
        self.model = os.getenv('GEMINI_MODEL', 'gemini-2.0-flash')
        self.base_url = (
            f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        )

    def format(self, fields: dict, phone: str):
        notes, debug = self._generate_notes(fields, phone)

        summary = f"""{'='*50}
NEW IMMIGRATION EMERGENCY INTAKE - {fields.get('priority', 'UNCLASSIFIED')}
{'='*50}

CONTACT INFORMATION
------------------
Name: {fields.get('full_name', 'N/A')}
Phone: {phone}
Callback Phone: {fields.get('callback_phone', 'N/A')}

TRIAGE DETAILS
--------------
Person at Risk: {fields.get('person_at_risk', 'N/A')}
Current Location: {fields.get('location', 'N/A')}
Urgency: {fields.get('urgency', 'N/A')}
A-number: {fields.get('a_number', 'N/A')}
Language: {fields.get('language', 'N/A')}

CLIENT DETAILS
--------------
{fields.get('details', 'N/A')}

STAFF NOTES
-----------
{notes}

{'='*50}
END OF INTAKE
{'='*50}"""

        return {
            'text': summary,
            'debug': debug,
            'notes': notes,
        }

    def _generate_notes(self, fields: dict, phone: str):
        prompt = f"""You are preparing internal triage notes for immigration staff.
Use only the facts provided below. Do not invent details. Do not give legal advice.
Write 3-5 concise bullet points covering urgency, location, callback needs, and follow-up context.

Facts:
- Name: {fields.get('full_name', 'N/A')}
- Phone: {phone}
- Callback Phone: {fields.get('callback_phone', 'N/A')}
- Priority: {fields.get('priority', 'N/A')}
- Person at Risk: {fields.get('person_at_risk', 'N/A')}
- Current Location: {fields.get('location', 'N/A')}
- Urgency: {fields.get('urgency', 'N/A')}
- A-number: {fields.get('a_number', 'N/A')}
- Language: {fields.get('language', 'N/A')}
- Details: {fields.get('details', 'N/A')}
"""
        debug = {
            'provider': 'gemini',
            'model': self.model,
            'api_configured': bool(self.api_key),
            'used_fallback': False,
            'fallback_reason': None,
            'http_status': None,
            'response_preview': None,
        }

        fallback_notes = self._fallback_notes(fields)
        if not self.api_key:
            debug['used_fallback'] = True
            debug['fallback_reason'] = 'missing_gemini_api_key'
            return fallback_notes, debug

        try:
            resp = requests.post(
                self.base_url,
                params={'key': self.api_key},
                headers={'Content-Type': 'application/json'},
                json={
                    'contents': [
                        {'parts': [{'text': prompt}]}
                    ],
                    'generationConfig': {
                        'temperature': 0.2,
                        'maxOutputTokens': 220,
                    },
                },
                timeout=30,
            )
            debug['http_status'] = resp.status_code
            resp.raise_for_status()
            result = resp.json()
            notes = self._parse_gemini_response(result)
            debug['response_preview'] = (notes or '')[:200]
            if not notes:
                debug['used_fallback'] = True
                debug['fallback_reason'] = 'empty_gemini_response'
                notes = fallback_notes
        except Exception as e:
            debug['used_fallback'] = True
            debug['fallback_reason'] = str(e)
            notes = fallback_notes

        return notes, debug

    def _parse_gemini_response(self, result):
        candidates = result.get('candidates', [])
        if not candidates:
            return None
        content = candidates[0].get('content', {})
        parts = content.get('parts', [])
        texts = [part.get('text', '') for part in parts if part.get('text')]
        return '\n'.join(t.strip() for t in texts if t.strip()) or None

    def _fallback_notes(self, fields: dict):
        bullets = [
            f"- Priority classified as {fields.get('priority', 'unclassified')}.",
            f"- Caller reports the person needing help is: {fields.get('person_at_risk', 'not provided')}.",
            f"- Current location reported as: {fields.get('location', 'not provided')}.",
            f"- Preferred callback language: {fields.get('language', 'not provided')}.",
            f"- Details: {fields.get('details', 'not provided')}."
        ]
        return '\n'.join(bullets)
