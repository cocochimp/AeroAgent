import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";

const {
  fetchNativeFlights, createNativeBooking, payNativeBooking,
  fetchNativeWatches, createNativeWatch, evaluateNativeWatch, fetchNativeAlerts,
} = globalThis.AeroAgentClient || {};

function recorder(payload) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => payload };
  };
  return { calls, fetchImpl };
}

const AUTH = { Authorization: "Bearer demo:u_wang", "Content-Type": "application/json" };

test("flight search encodes only the filled filters", async () => {
  const { calls, fetchImpl } = recorder({ flights: [] });
  await fetchNativeFlights({ query: { origin: "HGH", dest: "", date: "2026-11-21" }, userId: "u_wang", fetchImpl });
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/v1/flights?origin=HGH&date=2026-11-21");
  assert.deepEqual(calls[0].options.headers, AUTH);
});

test("booking requests send only server-priced fields", async () => {
  const { calls, fetchImpl } = recorder({ booking_id: "bk_1", status: "PENDING_PAYMENT" });
  await createNativeBooking({ flight: { flight_no: "MU5101", date: "2026-09-28" }, fareProduct: "Y",
    passenger: "王五", userId: "u_wang", fetchImpl });
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/v1/bookings");
  assert.deepEqual(JSON.parse(calls[0].options.body),
    { flight_no: "MU5101", date: "2026-09-28", fare_product: "Y", passenger: "王五" });
});

test("mock payment uses the booking route and idempotency key", async () => {
  const { calls, fetchImpl } = recorder({ status: "ISSUED", ticket_no: "781-1" });
  await payNativeBooking({ bookingId: "bk_1", idempotencyKey: "pay-1", userId: "u_wang", fetchImpl });
  assert.equal(calls[0].url, "http://127.0.0.1:8000/api/v1/bookings/bk_1/pay");
  assert.deepEqual(JSON.parse(calls[0].options.body), { idempotency_key: "pay-1" });
});

test("watch helpers use the documented endpoints and payload", async () => {
  const search = recorder({ watches: [] });
  await fetchNativeWatches({ userId: "u_wang", fetchImpl: search.fetchImpl });
  assert.equal(search.calls[0].url, "http://127.0.0.1:8000/api/v1/watches");

  const created = recorder({ watch_id: "watch_1" });
  await createNativeWatch({ watch: { flight_no: "MU5101", date: "2026-09-28", fare_product: "Y", target_total: 700 },
    userId: "u_wang", fetchImpl: created.fetchImpl });
  assert.deepEqual(JSON.parse(created.calls[0].options.body),
    { flight_no: "MU5101", date: "2026-09-28", fare_product: "Y", target_total: 700 });

  const evaluated = recorder({ alert: null });
  await evaluateNativeWatch({ watchId: "watch_1", userId: "u_wang", fetchImpl: evaluated.fetchImpl });
  assert.equal(evaluated.calls[0].options.method, "POST");
  assert.equal(evaluated.calls[0].url, "http://127.0.0.1:8000/api/v1/watches/watch_1/evaluate");

  const alerts = recorder({ alerts: [] });
  await fetchNativeAlerts({ userId: "u_wang", fetchImpl: alerts.fetchImpl });
  assert.equal(alerts.calls[0].url, "http://127.0.0.1:8000/api/v1/watches/alerts");
});