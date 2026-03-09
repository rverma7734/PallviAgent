"""
Conversation Manager
Maintains separate conversation history for each client using SQLite persistence.
"""
import json
import sqlite3
from datetime import datetime
from pathlib import Path


class ConversationManager:
    """Manages persistent conversation state for each client"""

    def __init__(self, db_path: str = "conversations.db"):
        self.db_path = str(Path(__file__).resolve().parent / db_path)
        self._init_db()

    def _connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_column(self, conn, table: str, column: str, ddl: str):
        existing = {row['name'] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    def _init_db(self):
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS conversations (
                    phone TEXT PRIMARY KEY,
                    fields_json TEXT NOT NULL DEFAULT '{}',
                    status TEXT NOT NULL DEFAULT 'active',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            self._ensure_column(conn, 'conversations', 'summary_text', 'TEXT')
            self._ensure_column(conn, 'conversations', 'summary_debug_json', 'TEXT')
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS messages (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    phone TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (phone) REFERENCES conversations(phone)
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_messages_phone_id ON messages(phone, id)"
            )

    def get_or_create(self, phone_number: str) -> dict:
        now = datetime.now().isoformat()

        with self._connect() as conn:
            row = conn.execute(
                "SELECT phone, fields_json, status, created_at, updated_at, summary_text, summary_debug_json FROM conversations WHERE phone = ?",
                (phone_number,),
            ).fetchone()

            if row is None:
                conn.execute(
                    """
                    INSERT INTO conversations (phone, fields_json, status, created_at, updated_at, summary_text, summary_debug_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (phone_number, "{}", "active", now, now, None, None),
                )
                return {
                    'phone': phone_number,
                    'messages': [],
                    'fields': {},
                    'status': 'active',
                    'created_at': now,
                    'updated_at': now,
                    'summary_text': None,
                    'summary_debug': None,
                }

            messages = self._get_messages(conn, phone_number)
            return {
                'phone': row['phone'],
                'messages': messages,
                'fields': json.loads(row['fields_json'] or '{}'),
                'status': row['status'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
                'summary_text': row['summary_text'],
                'summary_debug': json.loads(row['summary_debug_json']) if row['summary_debug_json'] else None,
            }

    def _get_messages(self, conn, phone_number: str) -> list:
        rows = conn.execute(
            "SELECT role, content, timestamp FROM messages WHERE phone = ? ORDER BY id ASC",
            (phone_number,),
        ).fetchall()
        return [dict(row) for row in rows]

    def add_message(self, phone_number: str, role: str, content: str):
        now = datetime.now().isoformat()
        self.get_or_create(phone_number)

        with self._connect() as conn:
            conn.execute(
                "INSERT INTO messages (phone, role, content, timestamp) VALUES (?, ?, ?, ?)",
                (phone_number, role, content, now),
            )
            conn.execute(
                "UPDATE conversations SET updated_at = ? WHERE phone = ?",
                (now, phone_number),
            )

    def update_fields(self, phone_number: str, fields: dict):
        now = datetime.now().isoformat()
        conversation = self.get_or_create(phone_number)
        merged_fields = dict(conversation.get('fields', {}))
        merged_fields.update(fields)

        with self._connect() as conn:
            conn.execute(
                "UPDATE conversations SET fields_json = ?, updated_at = ? WHERE phone = ?",
                (json.dumps(merged_fields), now, phone_number),
            )

    def save_summary(self, phone_number: str, summary_text: str, summary_debug: dict | None = None):
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                "UPDATE conversations SET summary_text = ?, summary_debug_json = ?, updated_at = ? WHERE phone = ?",
                (summary_text, json.dumps(summary_debug) if summary_debug else None, now, phone_number),
            )

    def mark_complete(self, phone_number: str):
        now = datetime.now().isoformat()
        with self._connect() as conn:
            conn.execute(
                "UPDATE conversations SET status = ?, updated_at = ? WHERE phone = ?",
                ('complete', now, phone_number),
            )

    def get_conversation(self, phone_number: str) -> dict:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT phone FROM conversations WHERE phone = ?",
                (phone_number,),
            ).fetchone()
        if row is None:
            return None
        return self.get_or_create(phone_number)

    def list_conversations(self) -> list:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT phone, status, created_at, updated_at, summary_text FROM conversations ORDER BY updated_at DESC"
            ).fetchall()
        return [
            {
                'phone': row['phone'],
                'status': row['status'],
                'created_at': row['created_at'],
                'updated_at': row['updated_at'],
                'has_summary': bool(row['summary_text']),
            }
            for row in rows
        ]

    def get_all_conversations(self) -> dict:
        with self._connect() as conn:
            rows = conn.execute("SELECT phone FROM conversations ORDER BY updated_at DESC").fetchall()
        return {row['phone']: self.get_or_create(row['phone']) for row in rows}

    def clear_conversation(self, phone_number: str):
        with self._connect() as conn:
            conn.execute("DELETE FROM messages WHERE phone = ?", (phone_number,))
            conn.execute("DELETE FROM conversations WHERE phone = ?", (phone_number,))

    def clear_all(self):
        with self._connect() as conn:
            conn.execute("DELETE FROM messages")
            conn.execute("DELETE FROM conversations")
