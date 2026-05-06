import unittest

import server


class IntakeFlowTest(unittest.TestCase):
    def setUp(self):
        self.client = server.app.test_client()
        self.sender = "test_flow_client"
        self.client.post("/simulate", json={"sender": self.sender, "message": "CLEAR"})

    def post_simulate(self, message):
        response = self.client.post("/simulate", json={"sender": self.sender, "message": message})
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def test_emergency_flow_classifies_p0(self):
        first = self.post_simulate("ICE detained my husband tonight")
        self.assertIn("Reply YES", first["response"])
        self.assertFalse(first["intake_complete"])

        answers = [
            "YES",
            "Maria Lopez",
            "+1 555 555 0123",
            "FAMILY",
            "Newark NJ",
            "2 detained now",
            "NONE",
            "Spanish",
            "ICE detained my husband tonight after a traffic stop.",
        ]
        result = None
        for answer in answers:
            result = self.post_simulate(answer)

        self.assertTrue(result["intake_complete"])
        self.assertEqual(result["fields"]["priority"], "P0")
        self.assertEqual(result["fields"]["language"], "Spanish")

    def test_help_and_stop_keywords(self):
        help_response = self.post_simulate("HELP")
        self.assertIn("Reply STOP", help_response["response"])

        stop_response = self.post_simulate("STOP")
        self.assertIn("opted out", stop_response["response"])

    def test_sms_webhook_returns_twiml(self):
        response = self.client.post(
            "/sms",
            data={"From": "+15555550199", "Body": "hello"},
            content_type="application/x-www-form-urlencoded",
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/xml", response.headers["Content-Type"])
        self.assertIn("<Response>", response.text)
        self.assertIn("<Message>", response.text)


if __name__ == "__main__":
    unittest.main()
