"use client";

import { useState, type FormEvent } from "react";

import { authClient } from "../../lib/auth-client";

export default function SignInPage() {
  const [channel, setChannel] = useState<"phone" | "email">("phone");
  const [destination, setDestination] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState("");

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const result =
      channel === "phone"
        ? await authClient.phoneNumber.sendOtp({ phoneNumber: destination })
        : await authClient.emailOtp.sendVerificationOtp({
            email: destination,
            type: "sign-in"
          });
    if (result.error !== null) {
      setMessage("We could not send a code. Check the details and try again.");
      return;
    }
    setSent(true);
    setMessage("Code sent.");
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const result =
      channel === "phone"
        ? await authClient.phoneNumber.verify({ phoneNumber: destination, code })
        : await authClient.signIn.emailOtp({ email: destination, otp: code });
    if (result.error !== null) {
      setMessage("That code is invalid or expired.");
      return;
    }
    window.location.assign("/shell");
  }

  return (
    <main>
      <section className="panel">
        <p className="eyebrow">Secure access</p>
        <h1>Sign in to Zabuni</h1>
        <div className="tabs" aria-label="Sign-in method">
          <button
            type="button"
            aria-pressed={channel === "phone"}
            onClick={() => {
              setChannel("phone");
            }}
          >
            Phone
          </button>
          <button
            type="button"
            aria-pressed={channel === "email"}
            onClick={() => {
              setChannel("email");
            }}
          >
            Email fallback
          </button>
        </div>
        {!sent ? (
          <form
            onSubmit={(event) => {
              void requestCode(event);
            }}
          >
            <label htmlFor="destination">
              {channel === "phone" ? "Phone number" : "Email address"}
            </label>
            <input
              id="destination"
              type={channel === "phone" ? "tel" : "email"}
              required
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
              }}
              placeholder={channel === "phone" ? "+254..." : "you@company.co.ke"}
            />
            <button type="submit">Send one-time code</button>
          </form>
        ) : (
          <form
            onSubmit={(event) => {
              void verifyCode(event);
            }}
          >
            <label htmlFor="code">Six-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
            <button type="submit">Verify and continue</button>
          </form>
        )}
        <p role="status">{message}</p>
      </section>
    </main>
  );
}
