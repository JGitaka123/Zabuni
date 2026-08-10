"use client";

import { useState, type FormEvent } from "react";

import { authClient } from "../../lib/auth-client";

export default function SignInPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");

  async function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setPending(true);
    const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setPending(false);
    if (result.error !== null) {
      setMessage("We could not send a code. Check the address and try again.");
      return;
    }
    setSent(true);
    setMessage(`We sent a six-digit code to ${email}. It expires in five minutes.`);
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    setPending(true);
    const result = await authClient.signIn.emailOtp({ email, otp: code });
    setPending(false);
    if (result.error !== null) {
      setMessage("That code is invalid or expired. Request a new one.");
      return;
    }
    window.location.assign("/shell");
  }

  return (
    <main>
      <section className="panel">
        <p className="eyebrow">Secure access</p>
        <h1>Sign in to Zabuni</h1>
        {!sent ? (
          <form
            onSubmit={(event) => {
              void requestCode(event);
            }}
          >
            <label htmlFor="email">Work email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
              placeholder="you@company.co.ke"
            />
            <button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send one-time code"}
            </button>
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
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              required
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
            <button type="submit" disabled={pending}>
              {pending ? "Verifying…" : "Verify and continue"}
            </button>
            <button
              type="button"
              className="link"
              onClick={() => {
                setSent(false);
                setCode("");
                setMessage("");
              }}
            >
              Use a different address
            </button>
          </form>
        )}
        <p role="status">{message}</p>
      </section>
    </main>
  );
}
