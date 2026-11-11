import { assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../shared/config.ts";
import { createDatabase } from "./client.ts";
import { assignSpeaker } from "./speaker-assignment.ts";
import { updateUtteranceSpeaker } from "./utterance-speaker.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: hlas lze přiřadit existující i nové osobě",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const episodeId = crypto.randomUUID();
    const processingRunId = crypto.randomUUID();
    const clusterId = crypto.randomUUID();
    const utteranceId = crypto.randomUUID();
    const moderatorId = crypto.randomUUID();
    const guestId = crypto.randomUUID();
    let newModeratorId: string | undefined;
    let newGuestId: string | undefined;
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Speaker assignment test', ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO persons (id, display_name, normalized_name, is_regular_host)
        VALUES
          (${moderatorId}, 'Testovací moderátor', 'testovaci moderator', true),
          (${guestId}, 'Existující host', 'existujici host', false)
      `;
      await sql`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${moderatorId}, 'moderator')
      `;
      await sql`
        INSERT INTO episodes (id, podcast_id, external_id, title, audio_url, processing_status)
        VALUES (
          ${episodeId}, ${podcastId}, 'speaker-assignment', 'Speaker assignment',
          'https://example.test/audio.mp3', 'transcribed'
        )
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
        VALUES (${processingRunId}, ${episodeId}, 'completed', 'integration')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = ${processingRunId} WHERE id = ${episodeId}
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds, segment_count
        ) VALUES (${clusterId}, ${episodeId}, ${processingRunId}, 'SPEAKER_00', 10, 1)
      `;
      await sql`
        INSERT INTO utterances (
          id, episode_id, processing_run_id, speaker_cluster_id, sequence_number,
          start_seconds, end_seconds, text
        ) VALUES (${utteranceId}, ${episodeId}, ${processingRunId}, ${clusterId}, 0, 0, 10, 'Test')
      `;

      assertEquals(
        await assignSpeaker(sql, clusterId, {
          assignmentType: "moderator",
          personId: moderatorId,
          verified: true,
          createReferenceEmbeddings: true,
          overwrite: false,
        }),
        { personId: moderatorId, personCreated: false },
      );
      await assertRejects(() =>
        assignSpeaker(sql, clusterId, {
          assignmentType: "guest",
          personId: moderatorId,
          verified: true,
          createReferenceEmbeddings: true,
          overwrite: true,
        })
      );
      await assertRejects(() =>
        assignSpeaker(sql, clusterId, {
          assignmentType: "guest",
          personId: guestId,
          verified: true,
          createReferenceEmbeddings: false,
          overwrite: true,
        })
      );
      await sql`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${guestId}, 'guest')
      `;
      assertEquals(await updateUtteranceSpeaker(sql, utteranceId, { speaker: guestId }), {
        utteranceId,
        personId: guestId,
        source: "manual",
        speakerLabel: "Existující host",
      });
      assertEquals(
        await assignSpeaker(sql, clusterId, {
          assignmentType: "guest",
          personId: guestId,
          verified: true,
          createReferenceEmbeddings: false,
          overwrite: true,
        }),
        { personId: guestId, personCreated: false },
      );
      const newModerator = await assignSpeaker(sql, clusterId, {
        assignmentType: "newModerator",
        displayName: "Petr Nový",
        description: "Nový stálý moderátor",
        verified: true,
        createReferenceEmbeddings: false,
        overwrite: true,
      });
      newModeratorId = newModerator.personId;
      assertEquals(newModerator.personCreated, true);
      assertEquals(
        (await sql`
          SELECT person.description, person.is_regular_host, participant.role,
            association.role AS podcast_role
          FROM persons person
          JOIN episode_participants participant ON participant.person_id = person.id
          JOIN podcast_persons association
            ON association.person_id = person.id
            AND association.podcast_id = ${podcastId}
          WHERE person.id = ${newModeratorId} AND participant.episode_id = ${episodeId}
        `)[0],
        {
          description: "Nový stálý moderátor",
          isRegularHost: true,
          role: "moderator",
          podcastRole: "moderator",
        },
      );
      const newGuest = await assignSpeaker(sql, clusterId, {
        assignmentType: "newGuest",
        displayName: "Žofie Testovací",
        description: "Nový host",
        verified: true,
        createReferenceEmbeddings: false,
        overwrite: true,
      });
      newGuestId = newGuest.personId;
      assertEquals(newGuest.personCreated, true);

      const preservedOverride = (await sql`
        SELECT person_id, speaker_assignment_source FROM utterances WHERE id = ${utteranceId}
      `)[0];
      assertEquals(preservedOverride, {
        personId: guestId,
        speakerAssignmentSource: "manual",
      });
      assertEquals(await updateUtteranceSpeaker(sql, utteranceId, { speaker: "cluster" }), {
        utteranceId,
        personId: newGuestId,
        source: "cluster",
        speakerLabel: "Žofie Testovací",
      });

      const assignment = (await sql`
        SELECT cluster.assigned_person_id,
          (SELECT person_id FROM utterances WHERE speaker_cluster_id = ${clusterId} LIMIT 1)
            AS utterance_person_id,
          person.display_name,
          person.normalized_name,
          person.is_regular_host,
          participant.role,
          association.role AS podcast_role
        FROM speaker_clusters cluster
        JOIN persons person ON person.id = cluster.assigned_person_id
        JOIN episode_participants participant
          ON participant.episode_id = cluster.episode_id
          AND participant.person_id = cluster.assigned_person_id
        JOIN podcast_persons association
          ON association.podcast_id = ${podcastId}
          AND association.person_id = cluster.assigned_person_id
        WHERE cluster.id = ${clusterId}
      `)[0];
      assertEquals(assignment, {
        assignedPersonId: newGuestId,
        utterancePersonId: newGuestId,
        displayName: "Žofie Testovací",
        normalizedName: "zofie testovaci",
        isRegularHost: false,
        role: "guest",
        podcastRole: "guest",
      });
    } finally {
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id IN (
        ${moderatorId}, ${guestId}, ${newModeratorId ?? null}, ${newGuestId ?? null}
      )`;
      await sql.end({ timeout: 5 });
    }
  },
});
