import type {
  AppointmentLedger,
  AppointmentRequest,
} from "./calendar_appointment.ts";
import type { ExecutableApprovalRecord } from "../_shared/booking_approval_gate.ts";

// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
export function appointmentLedger(sb: any): AppointmentLedger {
  const table = "ghl_calendar_appointment_requests";
  return {
    async get(locationId, key) {
      const { data, error } = await sb.from(table).select(
        "fingerprint,state,result",
      )
        .eq("location_id", locationId).eq("idempotency_key", key).maybeSingle();
      if (error) throw new Error("ledger_read_failed");
      return data as AppointmentRequest | null;
    },
    async reserve({ locationId, input, fingerprint, token }) {
      const { data, error } = await sb.rpc("reserve_ghl_calendar_appointment", {
        p_location_id: locationId,
        p_key: input.idempotencyKey,
        p_fingerprint: fingerprint,
        p_user_id: input.assignedUserId,
        p_start: input.startTime,
        p_end: input.endTime,
        p_token: token,
      });
      if (
        error || !data ||
        !["acquired", "busy", "overlap", "conflict", "existing"].includes(
          data.decision,
        )
      ) throw new Error("ledger_reserve_failed");
      return data;
    },
    async markSending(locationId, key, token) {
      const { data, error } = await sb.rpc(
        "mark_ghl_calendar_appointment_sending",
        {
          p_location_id: locationId,
          p_key: key,
          p_token: token,
        },
      );
      if (error) throw new Error("ledger_send_failed");
      return data === true;
    },
    async release(locationId, key, token) {
      const { error } = await sb.from(table).update({
        lease_until: "1970-01-01T00:00:00Z",
      })
        .eq("location_id", locationId).eq("idempotency_key", key)
        .eq("lease_token", token).eq("state", "reserved");
      if (error) throw new Error("ledger_release_failed");
    },
    async complete(locationId, key, fingerprint, result) {
      const { data, error } = await sb.from(table).update({
        state: "complete",
        result,
      })
        .eq("location_id", locationId).eq("idempotency_key", key)
        .eq("fingerprint", fingerprint).eq("state", "sending").select(
          "idempotency_key",
        );
      if (error) throw new Error("ledger_complete_failed");
      if (data?.length !== 1) {
        const winner = await this.get(locationId, key);
        if (
          winner?.fingerprint !== fingerprint || winner.state !== "complete" ||
          winner.result?.appointmentId !== result.appointmentId
        ) throw new Error("ledger_complete_conflict");
      }
    },
  };
}

/** Read-only: the writer never inserts, changes or deletes an approval. */
// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
export function bookingApprovalReader(sb: any): {
  find(bindingHash: string): Promise<ExecutableApprovalRecord | null>;
} {
  return {
    async find(bindingHash) {
      const { data, error } = await sb.from("sales_booking_approvals").select(
        "binding_hash,step,state,snapshot,approved_by_email,approved_at,expires_at",
      ).eq("binding_hash", bindingHash).maybeSingle();
      if (error) throw new Error("approval_read_failed");
      return (data as ExecutableApprovalRecord | null) ?? null;
    },
  };
}

/** Read-only: the writer never claims or settles an executor press. */
// Supabase's structural query builder is owned by the pinned runtime client.
// deno-lint-ignore no-explicit-any
export function bookingExecutionReader(sb: any): {
  find(bindingHash: string): Promise<
    {
      step: string;
      state: string;
      press_token: string;
      claimed_at: string;
    } | null
  >;
} {
  return {
    async find(bindingHash) {
      const { data, error } = await sb.from("sales_booking_executions").select(
        "step,state,press_token,claimed_at",
      ).eq("binding_hash", bindingHash).maybeSingle();
      if (error) throw new Error("execution_read_failed");
      return data ?? null;
    },
  };
}
