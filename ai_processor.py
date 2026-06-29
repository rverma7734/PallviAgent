"""Deterministic emergency intake flow and priority classification."""

REQUIRED_FIELDS = [
    'consent',
    'full_name',
    'callback_phone',
    'person_at_risk',
    'location',
    'urgency',
    'language',
    'details',
]

FIELD_QUESTIONS = {
    'consent': 'Reply YES to continue by text, or STOP to opt out.',
    'full_name': 'What is your full name?',
    'callback_phone': 'What phone number should staff call back?',
    'person_at_risk': 'Who needs help? Reply SELF, FAMILY, FRIEND, CLIENT, or OTHER.',
    'location': 'What city and state is the person in right now?',
    'urgency': 'What is happening? Reply 1 ICE is here now, 2 detained now, 3 hearing/removal/deadline within 72 hours, 4 general immigration help.',
    'language': 'What language should staff use when calling?',
    'details': 'Briefly describe what happened. Do not text documents, A-numbers, Social Security numbers, or passport numbers.',
}

PRIORITY_P0_TERMS = [
    'ice is here',
    'at the door',
    'detained',
    'custody',
    'taken',
    'arrested',
    'separated',
]

PRIORITY_P1_TERMS = [
    'tomorrow',
    '72 hours',
    'hearing',
    'court',
    'deadline',
    'removal',
    'deportation',
]


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
                'selected_next_field': needed[0] if needed else None,
            },
        }

    def _missing_fields(self, extracted_fields):
        return [field for field in REQUIRED_FIELDS if not extracted_fields.get(field)]

    def _extract_fields(self, messages, current):
        extracted = dict(current)
        client_messages = [
            m.get('content', '').strip()
            for m in messages
            if m.get('role') == 'client' and m.get('content')
        ]
        if not client_messages:
            return extracted

        latest_answer = client_messages[-1].strip()
        missing = self._missing_fields(extracted)
        next_field = missing[0] if missing else None
        if not next_field:
            return extracted

        if next_field == 'consent':
            if latest_answer.lower() in {'yes', 'y', 'start'}:
                extracted['consent'] = 'yes'
            return extracted

        extracted[next_field] = latest_answer

        if not self._missing_fields(extracted):
            extracted['priority'] = self._classify_priority(extracted)

        return extracted

    def _classify_priority(self, fields):
        urgency = str(fields.get('urgency', '')).lower()
        details = str(fields.get('details', '')).lower()
        combined = f"{urgency} {details}"

        if urgency.startswith('1') or urgency.startswith('2'):
            return 'P0'
        if any(term in combined for term in PRIORITY_P0_TERMS):
            return 'P0'
        if urgency.startswith('3') or any(term in combined for term in PRIORITY_P1_TERMS):
            return 'P1'
        return 'P2'
