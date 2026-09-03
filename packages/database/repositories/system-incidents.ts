import type postgres from "postgres";
import type { Sql } from "../client.ts";

export interface SystemIncidentInput {
  kind: string;
  fingerprint: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
  details: unknown;
}

export interface SystemIncident {
  id: string;
  kind: string;
  fingerprint: string;
  severity: "warning" | "critical";
  title: string;
  message: string;
  details: unknown;
  status: "open" | "accepted";
  occurrenceCount: number;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  lastNotifiedAt: Date | null;
  acceptedAt: Date | null;
  acceptedBy: string | null;
}

export interface NotificationReservation {
  incident: SystemIncident;
  reservedAt: Date;
  previousNotifiedAt: Date | null;
}

export class SystemIncidentRepository {
  constructor(private readonly sql: Sql) {}

  async record(input: SystemIncidentInput): Promise<SystemIncident> {
    const rows = await this.sql`
      INSERT INTO system_incidents (
        kind, fingerprint, severity, title, message, details
      ) VALUES (
        ${input.kind}, ${input.fingerprint}, ${input.severity}, ${input.title}, ${input.message},
        ${this.sql.json(toJson(input.details))}
      )
      ON CONFLICT (fingerprint) WHERE status = 'open'
      DO UPDATE SET severity = EXCLUDED.severity,
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        details = EXCLUDED.details,
        occurrence_count = system_incidents.occurrence_count + 1,
        last_detected_at = now(),
        updated_at = now()
      RETURNING *
    `;
    return rows[0] as unknown as SystemIncident;
  }

  async reserveNotification(
    incidentId: string,
    cooldownMs: number,
  ): Promise<NotificationReservation | null> {
    return await this.sql.begin(async (tx) => {
      const rows = await tx`
        SELECT * FROM system_incidents
        WHERE id = ${incidentId} AND status = 'open'
        FOR UPDATE
      `;
      if (!rows[0]) return null;
      const incident = rows[0] as unknown as SystemIncident;
      const previousNotifiedAt = incident.lastNotifiedAt;
      if (
        previousNotifiedAt &&
        previousNotifiedAt.getTime() > Date.now() - cooldownMs
      ) return null;
      const reservedAt = new Date();
      const updated = await tx`
        UPDATE system_incidents
        SET last_notified_at = ${reservedAt}, updated_at = now()
        WHERE id = ${incidentId} AND status = 'open'
        RETURNING *
      `;
      return {
        incident: updated[0] as unknown as SystemIncident,
        reservedAt,
        previousNotifiedAt,
      };
    });
  }

  async restoreNotificationReservation(reservation: NotificationReservation): Promise<void> {
    await this.sql`
      UPDATE system_incidents
      SET last_notified_at = ${reservation.previousNotifiedAt}, updated_at = now()
      WHERE id = ${reservation.incident.id}
        AND status = 'open'
        AND last_notified_at = ${reservation.reservedAt}
    `;
  }

  async accept(id: string, acceptedBy: string): Promise<SystemIncident | null> {
    const rows = await this.sql`
      UPDATE system_incidents
      SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()),
        accepted_by = COALESCE(accepted_by, ${acceptedBy}), updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    return rows[0] ? rows[0] as unknown as SystemIncident : null;
  }

  async list(limit = 200): Promise<SystemIncident[]> {
    const rows = await this.sql`
      SELECT * FROM system_incidents
      ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, last_detected_at DESC
      LIMIT ${limit}
    `;
    return rows as unknown as SystemIncident[];
  }
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
