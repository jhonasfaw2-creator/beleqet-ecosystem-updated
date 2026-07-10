"use client";

import { useEffect, useState } from "react";
import { loadStripe } from "@stripe/stripe-js";
import { Elements } from "@stripe/react-stripe-js";
import { CheckoutForm } from "../../components/payments/CheckoutForm";

// Initialize with a clean public test key placeholder
const stripePromise = loadStripe("pk_test_51Pxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");

export default function TestPaymentPage() {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Call your NestJS backend endpoint that creates a PaymentIntent
    // Adjust the URL/port if your backend runs on something other than localhost:3000
   fetch("http://localhost:3000/api/v1/payments/create-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 5000, currency: "usd" }), // $50.00 test item
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.clientSecret) {
          setClientSecret(data.clientSecret);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Error fetching payment intent:", err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return <div style={{ textAlign: "center", marginTop: "50px" }}>Initializing secure gateway...</div>;
  }

  if (!clientSecret) {
    return (
      <div style={{ maxWidth: "500px", margin: "50px auto", padding: "20px", color: "red" }}>
        <h3>Unable to load payment terminal</h3>
        <p>Make sure your NestJS backend is running and that your Stripe Secret Key is set in your backend .env file.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: "500px", margin: "50px auto", padding: "20px", fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: "24px", marginBottom: "20px", fontWeight: "bold" }}>
        Testing Stripe Payment Gateway
      </h1>
      
      <Elements stripe={stripePromise} options={{ clientSecret }}>
        <CheckoutForm clientSecret={clientSecret} />
      </Elements>
    </div>
  );
}