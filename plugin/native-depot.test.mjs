import test from "node:test";
import assert from "node:assert/strict";
import "./client.js";
import { rpcFetch } from "./tests/rpc-fetch.mjs";

const {
  fetchNativeFlights, createNativeBooking, payNativeBooking,
  fetchNativeWatches, createNativeWatch, evaluateNativeWatch, fetchNativeAlerts,
} = globalThis.AeroAgentClient;

test("flight search sends only filled filters", async () => {
  const rpc = rpcFetch({ "flights.search": async () => ({ flights: [] }) });
  await fetchNativeFlights({ query: { origin: "HGH", dest: "", date: "2026-11-21" }, userId: "u_wang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("flights.search"), { origin: "HGH", date: "2026-11-21" });
});

test("booking requests send only server-priced fields", async () => {
  const rpc = rpcFetch({ "bookings.create": async () => ({ booking_id: "bk_1", status: "PENDING_PAYMENT" }) });
  await createNativeBooking({ flight: { flight_no: "MU5101", date: "2026-09-28" }, fareProduct: "Y",
    passenger: "王五", userId: "u_wang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("bookings.create"),
    { flight_no: "MU5101", date: "2026-09-28", fare_product: "Y", passenger: "王五" });
});

test("mock payment uses booking id and idempotency key", async () => {
  const rpc = rpcFetch({ "bookings.pay": async () => ({ status: "ISSUED", ticket_no: "781-1" }) });
  await payNativeBooking({ bookingId: "bk_1", idempotencyKey: "pay-1", userId: "u_wang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.params("bookings.pay"), { booking_id: "bk_1", idempotency_key: "pay-1" });
});

test("watch helpers use the documented RPC methods", async () => {
  const rpc = rpcFetch({
    "watches.list": async () => ({ watches: [] }),
    "watches.create": async () => ({ watch_id: "watch_1" }),
    "watches.evaluate": async () => ({ alert: null }),
    "watches.alerts": async () => ({ alerts: [] }),
  });
  await fetchNativeWatches({ userId: "u_wang", fetchImpl: rpc.fetchImpl });
  await createNativeWatch({ watch: { flight_no: "MU5101", date: "2026-09-28", fare_product: "Y", target_total: 700 },
    userId: "u_wang", fetchImpl: rpc.fetchImpl });
  await evaluateNativeWatch({ watchId: "watch_1", userId: "u_wang", fetchImpl: rpc.fetchImpl });
  await fetchNativeAlerts({ userId: "u_wang", fetchImpl: rpc.fetchImpl });
  assert.deepEqual(rpc.methods(), ["watches.list", "watches.create", "watches.evaluate", "watches.alerts"]);
  assert.deepEqual(rpc.params("watches.evaluate"), { watch_id: "watch_1" });
});
