"""
Simulate Client
Test the intake agent without Twilio
"""
import requests

BASE_URL = "http://localhost:5005"


def simulate_conversation():
    """Run a simulated intake conversation"""
    sender = "test_client_001"

    print("=" * 50)
    print("IMMIGRATION INTAKE SIMULATION")
    print("=" * 50)
    print("Starting conversation...\n")

    clear_response = requests.post(f"{BASE_URL}/simulate", json={
        "sender": sender,
        "message": "CLEAR"
    })
    print(f"Reset: {clear_response.json()['response']}\n")

    print("Client: Hi, I need help with immigration")
    response = requests.post(f"{BASE_URL}/simulate", json={
        "sender": sender,
        "message": "Hi, I need help with immigration"
    })

    data = response.json()
    print(f"Agent: {data['response']}\n")

    conversation = [
        "Carlos Ramirez",
        "Guatemala",
        "I overstayed my tourist visa about 2 years ago",
        "I'm seeking asylum, I was threatened by gang violence",
        "May 2022",
        "I have no court date",
        "carlos.ramirez@email.com",
    ]

    for answer in conversation:
        print(f"Client: {answer}")

        response = requests.post(f"{BASE_URL}/simulate", json={
            "sender": sender,
            "message": answer
        })

        data = response.json()

        if data.get('intake_complete'):
            print(f"Agent: {data['response']}\n")
            print(f"\n{'=' * 50}")
            print("✅ INTAKE COMPLETE!")
            print(f"{'=' * 50}")
            print("\nCollected fields:")
            for k, v in data['fields'].items():
                print(f"  {k}: {v}")
            break
        else:
            print(f"Agent: {data['response']}\n")


if __name__ == "__main__":
    try:
        simulate_conversation()
    except requests.exceptions.ConnectionError:
        print("Error: Can't connect to server.")
        print("Make sure server.py is running: python server.py")
