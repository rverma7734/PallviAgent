"""
Summary Formatter
Creates an attorney-facing intake summary, with Gemini used for polished notes.
"""
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
NEW IMMIGRATION INTAKE
{'='*50}

CONTACT INFORMATION
------------------
Name: {fields.get('full_name', 'N/A')}
Phone: {phone}
Email: {fields.get('email', 'N/A')}

IMMIGRATION DETAILS
------------------
Country of Origin: {fields.get('country_of_origin', 'N/A')}
Current Status: {fields.get('immigration_status', 'N/A')}
Type of Help: {fields.get('help_type', 'N/A')}

TIMELINE
--------
US Entry Date: {fields.get('entry_date', 'N/A')}
Court Date: {fields.get('court_date', 'None reported')}

ATTORNEY NOTES
--------------
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
        prompt = f"""You are preparing internal notes for an immigration attorney.
Use only the facts provided below. Do not invent details. Do not give legal advice.
Write 3-5 concise bullet points covering the client's situation and follow-up context.

Facts:
- Name: {fields.get('full_name', 'N/A')}
- Phone: {phone}
- Email: {fields.get('email', 'N/A')}
- Country of Origin: {fields.get('country_of_origin', 'N/A')}
- Current Status: {fields.get('immigration_status', 'N/A')}
- Type of Help: {fields.get('help_type', 'N/A')}
- US Entry Date: {fields.get('entry_date', 'N/A')}
- Court Date: {fields.get('court_date', 'None reported')}
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
            f"- Client is seeking help related to {fields.get('help_type', 'immigration support').lower()}.",
            f"- Reported current immigration status: {fields.get('immigration_status', 'not provided')}.",
            f"- Country of origin listed as {fields.get('country_of_origin', 'not provided')}.",
            f"- US entry date reported as {fields.get('entry_date', 'not provided')}.",
            f"- Court date reported as {fields.get('court_date', 'None reported')}."
        ]
        return '\n'.join(bullets)
