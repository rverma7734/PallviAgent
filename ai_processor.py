"""
Intake Processor
Deterministic question flow + lightweight field extraction.
"""
import re

REQUIRED_FIELDS = [
    'full_name',
    'country_of_origin',
    'immigration_status',
    'help_type',
    'entry_date',
    'court_date',
    'email',
]

FIELD_QUESTIONS = {
    'full_name': 'Thank you. What is your full name?',
    'country_of_origin': 'Thank you. What is your country of origin?',
    'immigration_status': 'Thank you. What is your current immigration status?',
    'help_type': 'Thank you. What kind of immigration help are you seeking?',
    'entry_date': 'Thank you. When did you enter the United States?',
    'court_date': 'Thank you. Do you have a court date?',
    'email': 'Thank you. What is your email address?',
}


class AIProcessor:
    def process(self, messages, extracted_fields):
        extracted = self._extract_fields(messages, extracted_fields)
        needed = self._missing_fields(extracted)

        next_question = None if not needed else FIELD_QUESTIONS[needed[0]]

        return {
            'next_question': next_question,
            'extracted_fields': extracted,
            'intake_complete': len(needed) == 0,
            'debug': {
                'provider': 'deterministic',
                'used_fallback': False,
                'missing_fields': needed,
                'extracted_fields': extracted,
                'selected_next_field': needed[0] if needed else None,
            },
        }

    def _missing_fields(self, extracted_fields):
        return [field for field in REQUIRED_FIELDS if not extracted_fields.get(field)]

    def _extract_fields(self, messages, current):
        extracted = dict(current)
        recent_client_messages = [
            m.get('content', '').strip()
            for m in messages
            if m.get('role') == 'client' and m.get('content')
        ]
        full_text = ' '.join(recent_client_messages)
        lower_text = full_text.lower()

        email_match = re.search(r'[\w.\-+]+@[\w.\-]+\.[A-Za-z]{2,}', full_text)
        if email_match:
            extracted['email'] = email_match.group(0)

        if not extracted.get('full_name'):
            for message in recent_client_messages[:3]:
                candidate = message.strip()
                if re.fullmatch(r"[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?", candidate):
                    extracted['full_name'] = candidate
                    break

        for country in ['guatemala', 'mexico', 'el salvador', 'honduras', 'china', 'india', 'haiti']:
            if country in lower_text:
                extracted['country_of_origin'] = country.title()
                break

        if 'overstay' in lower_text or 'overstayed' in lower_text:
            extracted['immigration_status'] = 'Overstayed visa'
        elif 'asylum' in lower_text:
            extracted['immigration_status'] = 'Seeking asylum'
        elif 'visa' in lower_text:
            extracted['immigration_status'] = 'Visa holder'

        if 'asylum' in lower_text:
            extracted['help_type'] = 'Asylum'
        elif 'green card' in lower_text:
            extracted['help_type'] = 'Green card'
        elif 'work permit' in lower_text:
            extracted['help_type'] = 'Work permit'
        elif 'visa' in lower_text:
            extracted['help_type'] = 'Visa'
        elif 'court' in lower_text:
            extracted['help_type'] = 'Defense'

        month_year_pattern = re.compile(
            r'(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}',
            re.IGNORECASE,
        )
        for message in recent_client_messages:
            date_match = month_year_pattern.search(message)
            if not date_match:
                continue
            date_value = date_match.group(0).title()
            lowered = message.lower()
            if 'court' in lowered:
                extracted['court_date'] = date_value
            elif not extracted.get('entry_date'):
                extracted['entry_date'] = date_value

        if 'no court' in lower_text or 'no upcoming court' in lower_text or 'none' in lower_text:
            extracted['court_date'] = 'None'

        return extracted
