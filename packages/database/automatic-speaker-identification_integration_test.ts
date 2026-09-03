import { assertEquals } from "@std/assert";
import { createDatabase } from "./client.ts";
import { loadConfig } from "../shared/config.ts";
import { automaticallyAssignRegularHostsForEpisode } from "./speaker-matching.ts";
import {
  assignSingleUnknownGuest,
  enqueueGuestIdentificationAfterSpeakerAssignment,
  singleUnknownSpeakerContext,
} from "./automatic-speaker-identification.ts";

const enabled = Deno.env.get("RUN_INTEGRATION_TESTS") === "1";

Deno.test({
  name: "integration: pipeline automaticky přiřadí moderátora a jediného hosta z metadat",
  ignore: !enabled,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = createDatabase(loadConfig());
    const podcastId = crypto.randomUUID();
    const referenceEpisodeId = crypto.randomUUID();
    const targetEpisodeId = crypto.randomUUID();
    const referenceRunId = crypto.randomUUID();
    const targetRunId = crypto.randomUUID();
    const referenceClusterId = crypto.randomUUID();
    const targetModeratorClusterId = crypto.randomUUID();
    const targetGuestClusterId = crypto.randomUUID();
    const moderatorId = crypto.randomUUID();
    const existingGuestId = crypto.randomUUID();
    const newGuestEpisodeId = crypto.randomUUID();
    const newGuestRunId = crypto.randomUUID();
    const newGuestClusterId = crypto.randomUUID();
    let createdGuestId: string | null = null;
    let guestIdentificationJobId: string | null = null;
    const moderatorVector = `[${[1, ...Array<number>(255).fill(0)].join(",")}]`;
    const guestVector = `[${[0, 1, ...Array<number>(254).fill(0)].join(",")}]`;
    try {
      await sql`
        INSERT INTO podcasts (id, name, rss_url)
        VALUES (${podcastId}, 'Automatic speaker test',
          ${`https://example.test/${podcastId}.xml`})
      `;
      await sql`
        INSERT INTO persons (id, display_name, normalized_name, is_regular_host)
        VALUES
          (${moderatorId}, 'Testovací Moderátor', 'testovaci moderator', true),
          (${existingGuestId}, 'Jana Nováková', 'jana novakova', false)
      `;
      await sql`
        INSERT INTO podcast_persons (podcast_id, person_id, role)
        VALUES (${podcastId}, ${moderatorId}, 'moderator')
      `;
      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, description, audio_url, processing_status
        ) VALUES
          (${referenceEpisodeId}, ${podcastId}, 'reference', 'Reference', NULL,
            'https://example.test/reference.mp3', 'ready'),
          (${targetEpisodeId}, ${podcastId}, 'target', 'Rozhovor s Janou Novákovou',
            'Hostem této epizody je Jana Nováková.',
            'https://example.test/target.mp3', 'transcribed')
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
        VALUES
          (${referenceRunId}, ${referenceEpisodeId}, 'completed', 'test'),
          (${targetRunId}, ${targetEpisodeId}, 'completed', 'test')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = CASE
          WHEN id = ${referenceEpisodeId} THEN ${referenceRunId}::uuid
          ELSE ${targetRunId}::uuid END
        WHERE id IN (${referenceEpisodeId}, ${targetEpisodeId})
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds,
          segment_count, assigned_person_id, identity_status
        ) VALUES
          (${referenceClusterId}, ${referenceEpisodeId}, ${referenceRunId}, 'SPEAKER_00',
            60, 10, ${moderatorId}, 'verified'),
          (${targetModeratorClusterId}, ${targetEpisodeId}, ${targetRunId}, 'SPEAKER_00',
            60, 10, NULL, 'unknown'),
          (${targetGuestClusterId}, ${targetEpisodeId}, ${targetRunId}, 'SPEAKER_01',
            120, 20, NULL, 'unknown')
      `;
      await sql`
        INSERT INTO speaker_embeddings (
          processing_run_id, person_id, speaker_cluster_id, model_name, embedding,
          dimensions, source_type, duration_seconds, is_verified
        ) VALUES
          (${referenceRunId}, ${moderatorId}, ${referenceClusterId}, 'test-model',
            ${moderatorVector}::vector, 256, 'verified_cluster', 60, true),
          (${targetRunId}, NULL, ${targetModeratorClusterId}, 'test-model',
            ${moderatorVector}::vector, 256, 'cluster_centroid', 60, false),
          (${targetRunId}, NULL, ${targetGuestClusterId}, 'test-model',
            ${guestVector}::vector, 256, 'cluster_centroid', 120, false)
      `;
      await sql`
        INSERT INTO utterances (
          episode_id, processing_run_id, speaker_cluster_id, sequence_number,
          start_seconds, end_seconds, text
        ) VALUES
          (${targetEpisodeId}, ${targetRunId}, ${targetModeratorClusterId}, 0, 0, 10,
            'Úvod moderátora.'),
          (${targetEpisodeId}, ${targetRunId}, ${targetGuestClusterId}, 1, 10, 20,
            'Odpověď hosta.')
      `;

      assertEquals(await singleUnknownSpeakerContext(sql, targetEpisodeId), null);
      const moderators = await automaticallyAssignRegularHostsForEpisode(sql, targetEpisodeId);
      assertEquals(moderators.map((item) => item.personId), [moderatorId]);
      assertEquals(await automaticallyAssignRegularHostsForEpisode(sql, targetEpisodeId), []);

      const context = await singleUnknownSpeakerContext(sql, targetEpisodeId);
      assertEquals(context?.clusterId, targetGuestClusterId);
      if (!context) throw new Error("Chybí jediný neznámý hlas pro test hosta.");
      guestIdentificationJobId = await enqueueGuestIdentificationAfterSpeakerAssignment(
        sql,
        targetModeratorClusterId,
        4,
      );
      const guestIdentificationJob = await sql`
        SELECT type, entity_id, payload, priority, max_attempts
        FROM jobs WHERE id = ${guestIdentificationJobId}
      `;
      assertEquals(guestIdentificationJob[0], {
        type: "IDENTIFY_SPEAKERS",
        entityId: targetEpisodeId,
        payload: {
          continuePipeline: false,
          nonBlocking: true,
          source: "manual_moderator_assignment",
        },
        priority: 10,
        maxAttempts: 4,
      });
      const guest = await assignSingleUnknownGuest(sql, context, {
        displayName: "Jana Nováková",
        confidence: 0.9,
        evidence: "Hostem této epizody je Jana Nováková.",
      });
      assertEquals(guest, {
        status: "assigned",
        clusterId: targetGuestClusterId,
        personId: existingGuestId,
        personCreated: false,
      });
      assertEquals(await singleUnknownSpeakerContext(sql, targetEpisodeId), null);

      const clusters = await sql`
        SELECT id, assigned_person_id, identity_status, identity_source
        FROM speaker_clusters
        WHERE processing_run_id = ${targetRunId}
        ORDER BY local_label
      `;
      assertEquals(
        clusters.map((cluster) => ({
          id: String(cluster.id),
          personId: String(cluster.assignedPersonId),
          status: cluster.identityStatus,
          source: cluster.identitySource,
        })),
        [
          {
            id: targetModeratorClusterId,
            personId: moderatorId,
            status: "verified",
            source: "automatic_voice_match",
          },
          {
            id: targetGuestClusterId,
            personId: existingGuestId,
            status: "verified",
            source: "llm_episode_metadata",
          },
        ],
      );
      const participants = await sql`
        SELECT person_id, role, source FROM episode_participants
        WHERE episode_id = ${targetEpisodeId}
        ORDER BY role
      `;
      assertEquals(
        participants.map((participant) => ({
          personId: String(participant.personId),
          role: participant.role,
          source: participant.source,
        })),
        [
          { personId: existingGuestId, role: "guest", source: "llm" },
          { personId: moderatorId, role: "moderator", source: "voice_match" },
        ],
      );
      const podcastPeople = await sql`
        SELECT person_id, role
        FROM podcast_persons
        WHERE podcast_id = ${podcastId}
        ORDER BY role, person_id
      `;
      assertEquals(
        podcastPeople.map((association) => ({
          personId: String(association.personId),
          role: association.role,
        })),
        [
          { personId: existingGuestId, role: "guest" },
          { personId: moderatorId, role: "moderator" },
        ],
      );
      const utterances = await sql`
        SELECT person_id FROM utterances
        WHERE processing_run_id = ${targetRunId}
        ORDER BY sequence_number
      `;
      assertEquals(utterances.map((utterance) => String(utterance.personId)), [
        moderatorId,
        existingGuestId,
      ]);
      const targetReference = await sql`
        SELECT is_verified FROM speaker_embeddings
        WHERE speaker_cluster_id = ${targetModeratorClusterId}
      `;
      assertEquals(targetReference[0]?.isVerified, false);
      const guestCount = await sql`
        SELECT count(*)::int AS count FROM persons WHERE normalized_name = 'jana novakova'
      `;
      assertEquals(Number(guestCount[0]?.count), 1);

      await sql`
        INSERT INTO episodes (
          id, podcast_id, external_id, title, description, audio_url, processing_status
        ) VALUES (
          ${newGuestEpisodeId}, ${podcastId}, 'new-guest', 'Rozhovor s Petrem Novým',
          'Hostem je Petr Nový.', 'https://example.test/new-guest.mp3', 'transcribed'
        )
      `;
      await sql`
        INSERT INTO processing_runs (id, episode_id, status, pipeline_version)
        VALUES (${newGuestRunId}, ${newGuestEpisodeId}, 'completed', 'test')
      `;
      await sql`
        UPDATE episodes SET active_processing_run_id = ${newGuestRunId}
        WHERE id = ${newGuestEpisodeId}
      `;
      await sql`
        INSERT INTO speaker_clusters (
          id, episode_id, processing_run_id, local_label, total_speech_seconds, segment_count
        ) VALUES (
          ${newGuestClusterId}, ${newGuestEpisodeId}, ${newGuestRunId}, 'SPEAKER_00', 90, 15
        )
      `;
      const newGuestContext = await singleUnknownSpeakerContext(sql, newGuestEpisodeId);
      if (!newGuestContext) throw new Error("Chybí kontext pro vytvoření nového hosta.");
      const newGuest = await assignSingleUnknownGuest(sql, newGuestContext, {
        displayName: "Petr Nový",
        confidence: 0.9,
        evidence: "Hostem je Petr Nový.",
      });
      assertEquals(newGuest.status, "assigned");
      assertEquals(newGuest.personCreated, true);
      if (!newGuest.personId) throw new Error("Nový host nemá ID.");
      createdGuestId = newGuest.personId;
      const createdPerson = await sql`
        SELECT person.display_name, person.is_regular_host, association.role AS podcast_role
        FROM persons person
        JOIN podcast_persons association
          ON association.person_id = person.id
          AND association.podcast_id = ${podcastId}
        WHERE person.id = ${createdGuestId}
      `;
      assertEquals(createdPerson[0], {
        displayName: "Petr Nový",
        isRegularHost: false,
        podcastRole: "guest",
      });
    } finally {
      if (guestIdentificationJobId) {
        await sql`DELETE FROM jobs WHERE id = ${guestIdentificationJobId}`;
      }
      await sql`DELETE FROM podcasts WHERE id = ${podcastId}`;
      await sql`DELETE FROM persons WHERE id IN (${moderatorId}, ${existingGuestId})`;
      if (createdGuestId) await sql`DELETE FROM persons WHERE id = ${createdGuestId}`;
      await sql.end({ timeout: 5 });
    }
  },
});
