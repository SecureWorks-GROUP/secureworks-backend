// A scheduling preview of existing supplier facts. No assumed fabrication days,
// changed bookings, supplier messages, invoice actions or writes.
import { isDispatchDeliveryDate } from "./dispatch_deliveries.ts";

type SupplierArrival = {
  supplier_id?: string | null;
  supplier_name?: string | null;
  delivery_date?: string | null;
  date_confirmed?: boolean;
  date_source?: string | null;
  box_date_source?: string | null;
  material_stage?: string | null;
  extra?: boolean;
};

export type ScheduleSupplyWarning = {
  code:
    | "supplier_dates_unreadable"
    | "supplier_dates_missing"
    | "supplier_date_missing"
    | "supplier_date_unconfirmed"
    | "supplier_ready_after_install";
  supplier_id: string | null;
  supplier_name: string | null;
  delivery_date: string | null;
  date_confirmed: boolean;
  date_source: string | null;
  box_date_source: string | null;
  message: string;
};

export function dispatchScheduleWarnings(
  proposedInstallDate: string,
  arrival: { orders: SupplierArrival[] } | null,
  readable: boolean,
) {
  const warnings: ScheduleSupplyWarning[] = [];
  const warn = (
    code: ScheduleSupplyWarning["code"],
    message: string,
    order: SupplierArrival = {},
  ) =>
    warnings.push({
      code,
      supplier_id: order.supplier_id ?? null,
      supplier_name: order.supplier_name ?? null,
      delivery_date: isDispatchDeliveryDate(order.delivery_date)
        ? order.delivery_date
        : null,
      date_confirmed: order.date_confirmed === true,
      date_source: order.date_source ?? null,
      box_date_source: order.box_date_source ?? null,
      message,
    });
  let latestConfirmed: string | null = null;
  if (!readable || !arrival) {
    warn(
      "supplier_dates_unreadable",
      "Supplier and fabricator dates could not be checked. Confirm availability before starting.",
    );
  } else {
    const pending = arrival.orders.filter((order) =>
      !order.extra && order.material_stage !== "delivered"
    );
    if (arrival.orders.length === 0) {
      warn(
        "supplier_dates_missing",
        "No supplier or fabricator ready dates are recorded. Confirm availability before starting.",
      );
    }
    for (const order of pending) {
      const name = order.supplier_name || "Supplier";
      const date = isDispatchDeliveryDate(order.delivery_date)
        ? order.delivery_date
        : null;
      if (!date) {
        warn(
          "supplier_date_missing",
          `${name}: no ready or delivery date is recorded.`,
          order,
        );
        continue;
      }
      if (order.date_confirmed === true) {
        if (!latestConfirmed || date > latestConfirmed) latestConfirmed = date;
      } else {
        warn(
          "supplier_date_unconfirmed",
          `${name}: ${date} is not confirmed by the supplier.`,
          order,
        );
      }
      if (date > proposedInstallDate) {
        warn(
          "supplier_ready_after_install",
          `${name}: ready or delivery date ${date} is after the proposed install ${proposedInstallDate}.`,
          order,
        );
      }
    }
  }
  return {
    proposed_install_date: proposedInstallDate,
    latest_confirmed_delivery_date: latestConfirmed,
    schedule_warnings: warnings,
  };
}
