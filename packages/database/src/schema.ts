import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type {
  LearningProgressReport,
  QueryRunModelCall,
  SourceLocator,
  WikiCompileProfile
} from "@wknowledge/contracts";

export const roleEnum = pgEnum("role", ["owner", "admin", "editor", "learner", "viewer"]);
export const dataPolicyEnum = pgEnum("data_policy", [
  "local_only",
  "cloud_allowed",
  "cloud_allowed_after_redaction"
]);
export const resourceStatusEnum = pgEnum("resource_status", [
  "uploaded",
  "queued",
  "processing",
  "ready",
  "cancelled",
  "failed"
]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "processing",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed"
]);
export const learningPlanStatusEnum = pgEnum("learning_plan_status", [
  "draft",
  "active",
  "completed",
  "archived"
]);
export const courseStatusEnum = pgEnum("course_status", ["active", "archived"]);
export const practiceSetStatusEnum = pgEnum("practice_set_status", ["candidate", "archived"]);
export const assessmentStatusEnum = pgEnum("assessment_status", ["draft", "active", "submitted"]);
export const practiceDifficultyEnum = pgEnum("practice_difficulty", [
  "easy",
  "standard",
  "challenge"
]);
export const practiceAttemptStatusEnum = pgEnum("practice_attempt_status", ["pending_review"]);
export const learningReportStatusEnum = pgEnum("learning_report_status", [
  "queued",
  "rendering",
  "completed",
  "failed"
]);
export const learningReportArtifactFormatEnum = pgEnum("learning_report_artifact_format", [
  "png",
  "pdf"
]);
export const providerLocationEnum = pgEnum("provider_location", ["local", "cloud"]);
export const providerHealthEnum = pgEnum("provider_health", ["unknown", "healthy", "unhealthy"]);
export const jobOutboxStatusEnum = pgEnum("job_outbox_status", [
  "pending",
  "dispatching",
  "sent",
  "discarded"
]);
export const resourceUploadStatusEnum = pgEnum("resource_upload_status", [
  "open",
  "finalizing",
  "completed",
  "failed",
  "expired",
  "aborted"
]);
export const agentSessionStatusEnum = pgEnum("agent_session_status", ["active", "archived"]);
export const agentContextBindingStatusEnum = pgEnum("agent_context_binding_status", [
  "active",
  "removed",
  "revoked"
]);
export const agentMessageRoleEnum = pgEnum("agent_message_role", ["user", "assistant"]);
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "completed",
  "failed",
  "stopped"
]);
export const skillApprovalStatusEnum = pgEnum("skill_approval_status", [
  "pending",
  "approved",
  "rejected",
  "expired"
]);
export const skillRunStatusEnum = pgEnum("skill_run_status", [
  "queued",
  "running",
  "completed",
  "failed",
  "stopped"
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
};

export const organizations = pgTable("organization", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  storageQuotaBytes: integer("storage_quota_bytes").notNull().default(1_073_741_824),
  ...timestamps
});

export const users = pgTable(
  "app_user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    ...timestamps
  },
  (table) => [uniqueIndex("app_user_email_unique").on(table.email)]
);

export const organizationMemberships = pgTable(
  "organization_membership",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    disabled: boolean("disabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.userId] }),
    index("organization_membership_active_user_idx").on(table.userId, table.disabled)
  ]
);

export const organizationInvitations = pgTable(
  "organization_invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    organizationRole: roleEnum("organization_role").notNull(),
    spaceId: uuid("space_id").references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    spaceRole: roleEnum("space_role"),
    tokenHash: text("token_hash").notNull(),
    invitedBy: uuid("invited_by")
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("organization_invitation_token_unique").on(table.tokenHash),
    index("organization_invitation_org_idx").on(table.organizationId, table.createdAt)
  ]
);

export const sessions = pgTable(
  "app_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("app_session_token_unique").on(table.tokenHash),
    index("app_session_user_idx").on(table.userId)
  ]
);

export const requestRateLimits = pgTable("request_rate_limit", {
  key: text("key").primaryKey(),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true }).notNull().defaultNow(),
  count: integer("count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const signupVerificationCodes = pgTable(
  "signup_verification_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("signup_verification_email_created_idx").on(table.email, table.createdAt)]
);

export const knowledgeSpaces = pgTable(
  "knowledge_space",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    dataPolicy: dataPolicyEnum("data_policy").notNull().default("local_only"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps
  },
  (table) => [index("knowledge_space_org_idx").on(table.organizationId)]
);

export const spaceMemberships = pgTable(
  "space_membership",
  {
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.spaceId, table.userId] }),
    index("space_member_user_idx").on(table.userId)
  ]
);

export const resources = pgTable(
  "resource",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: resourceStatusEnum("status").notNull().default("uploaded"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps
  },
  (table) => [index("resource_space_idx").on(table.spaceId)]
);

export const resourceVersions = pgTable(
  "resource_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceId: uuid("resource_id")
      .notNull()
      .references(() => resources.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    blobUri: text("blob_uri").notNull(),
    compileProfile: text("compile_profile")
      .$type<WikiCompileProfile>()
      .notNull()
      .default("reference"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("resource_version_number_unique").on(table.resourceId, table.version),
    index("resource_version_hash_idx").on(table.sha256)
  ]
);

export const resourceUploads = pgTable(
  "resource_upload",
  {
    id: uuid("id").primaryKey(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    compileProfile: text("compile_profile")
      .$type<WikiCompileProfile>()
      .notNull()
      .default("reference"),
    partSize: integer("part_size").notNull(),
    totalParts: integer("total_parts").notNull(),
    status: resourceUploadStatusEnum("status").notNull().default("open"),
    duplicate: boolean("duplicate").notNull().default(false),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    storageReservationId: uuid("storage_reservation_id").references(() => storageReservations.id, {
      onDelete: "set null"
    }),
    resourceVersionId: uuid("resource_version_id").references(() => resourceVersions.id, {
      onDelete: "set null"
    }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps
  },
  (table) => [
    index("resource_upload_user_idx").on(table.userId, table.createdAt),
    index("resource_upload_space_status_idx").on(table.spaceId, table.status, table.expiresAt)
  ]
);

export const storageReservations = pgTable(
  "storage_reservation",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    byteSize: integer("byte_size").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("storage_reservation_org_expiry_idx").on(table.organizationId, table.expiresAt)]
);

export const derivedStorageAssets = pgTable(
  "derived_storage_asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assetKey: text("asset_key").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("derived_storage_asset_org_key_unique").on(table.organizationId, table.assetKey),
    index("derived_storage_asset_org_idx").on(table.organizationId)
  ]
);

export const resourceUploadParts = pgTable(
  "resource_upload_part",
  {
    uploadId: uuid("upload_id")
      .notNull()
      .references(() => resourceUploads.id, { onDelete: "cascade" }),
    partNumber: integer("part_number").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: text("sha256").notNull(),
    blobUri: text("blob_uri").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.uploadId, table.partNumber] }),
    index("resource_upload_part_upload_idx").on(table.uploadId)
  ]
);

export const processingJobs = pgTable(
  "processing_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    resourceVersionId: uuid("resource_version_id").references(() => resourceVersions.id, {
      onDelete: "cascade"
    }),
    queueJobId: uuid("queue_job_id"),
    executionToken: text("execution_token"),
    executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
    kind: text("kind").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    stage: text("stage").notNull().default("queued"),
    progress: integer("progress").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [index("processing_job_space_idx").on(table.spaceId)]
);

export const jobOutbox = pgTable(
  "job_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    processingJobId: uuid("processing_job_id")
      .notNull()
      .references(() => processingJobs.id, { onDelete: "cascade" }),
    resourceVersionId: uuid("resource_version_id").references(() => resourceVersions.id, {
      onDelete: "cascade"
    }),
    kind: text("kind").notNull().default("resource.process"),
    uploadId: uuid("upload_id").references(() => resourceUploads.id, { onDelete: "cascade" }),
    status: jobOutboxStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchToken: text("dispatch_token"),
    dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", { withTimezone: true }),
    queueJobId: uuid("queue_job_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("job_outbox_processing_job_unique").on(table.processingJobId),
    index("job_outbox_dispatch_idx").on(table.status, table.dispatchLeaseExpiresAt, table.createdAt)
  ]
);

export const sourceLocators = pgTable(
  "source_locator",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    resourceVersionId: uuid("resource_version_id")
      .notNull()
      .references(() => resourceVersions.id, { onDelete: "cascade" }),
    locator: jsonb("locator").$type<SourceLocator>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("source_locator_version_idx").on(table.resourceVersionId)]
);

export const auditEvents = pgTable(
  "audit_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("audit_event_org_created_idx").on(table.organizationId, table.createdAt)]
);

export const wikiPublicationLocks = pgTable("wiki_publication_lock", {
  spaceId: uuid("space_id")
    .primaryKey()
    .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
  ownerToken: text("owner_token").notNull(),
  operation: text("operation").notNull(),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
});

export const modelProviders = pgTable(
  "model_provider",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("openai_compatible"),
    capabilities: jsonb("capabilities").$type<string[]>().notNull().default(["chat"]),
    location: providerLocationEnum("location").notNull(),
    baseUrl: text("base_url").notNull(),
    model: text("model").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    encryptedApiKey: text("encrypted_api_key"),
    credentialIv: text("credential_iv"),
    credentialTag: text("credential_tag"),
    timeoutMs: integer("timeout_ms").notNull().default(20_000),
    health: providerHealthEnum("health").notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps
  },
  (table) => [index("model_provider_org_idx").on(table.organizationId, table.updatedAt)]
);

export const workerHeartbeats = pgTable("worker_heartbeat", {
  instanceId: text("instance_id").primaryKey(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const skillInstallations = pgTable(
  "skill_installation",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    version: text("version").notNull(),
    digest: text("digest").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps
  },
  (table) => [
    primaryKey({ columns: [table.organizationId, table.skillId] }),
    index("skill_installation_org_idx").on(table.organizationId)
  ]
);

export const queryRuns = pgTable(
  "query_run",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    questionSha256: text("question_sha256").notNull(),
    questionLength: integer("question_length").notNull(),
    answerMode: text("answer_mode").$type<"generated" | "extractive_fallback">().notNull(),
    insufficientEvidence: boolean("insufficient_evidence").notNull(),
    searchedPages: integer("searched_pages").notNull(),
    embeddingCalls: integer("embedding_calls").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
    candidateCount: integer("candidate_count").notNull(),
    citedCount: integer("cited_count").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("query_run_org_created_idx").on(table.organizationId, table.createdAt),
    index("query_run_space_created_idx").on(table.spaceId, table.createdAt)
  ]
);

export const queryEvidenceCandidates = pgTable(
  "query_evidence_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryRunId: uuid("query_run_id")
      .notNull()
      .references(() => queryRuns.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id").notNull(),
    pageId: text("page_id").notNull(),
    pageTitle: text("page_title").notNull(),
    pageType: text("page_type").notNull(),
    rank: integer("rank").notNull(),
    sourceCount: integer("source_count").notNull(),
    cited: boolean("cited").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("query_evidence_run_rank_unique").on(table.queryRunId, table.rank),
    index("query_evidence_run_idx").on(table.queryRunId)
  ]
);

export const modelCalls = pgTable(
  "model_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    queryRunId: uuid("query_run_id")
      .notNull()
      .references(() => queryRuns.id, { onDelete: "cascade" })
      .unique(),
    providerId: text("provider_id"),
    model: text("model"),
    capability: text("capability").$type<QueryRunModelCall["capability"]>().notNull(),
    status: text("status").$type<QueryRunModelCall["status"]>().notNull(),
    durationMs: integer("duration_ms").notNull(),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("model_call_query_run_idx").on(table.queryRunId)]
);

export const agentSessions = pgTable(
  "agent_session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    status: agentSessionStatusEnum("status").notNull().default("active"),
    ...timestamps
  },
  (table) => [
    index("agent_session_user_updated_idx").on(table.userId, table.updatedAt),
    index("agent_session_org_created_idx").on(table.organizationId, table.createdAt)
  ]
);

export const agentContextBindings = pgTable(
  "agent_context_binding",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    scope: text("scope")
      .$type<"space" | "wiki_page" | "resource_version" | "course">()
      .notNull()
      .default("space"),
    targetId: text("target_id"),
    virtualPath: text("virtual_path").notNull(),
    label: text("label").notNull(),
    status: agentContextBindingStatusEnum("status").notNull().default("active"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_context_session_scope_target_unique").on(
      table.sessionId,
      table.spaceId,
      table.scope,
      table.targetId
    ),
    index("agent_context_session_status_idx").on(table.sessionId, table.status)
  ]
);

export const agentMessages = pgTable(
  "agent_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    role: agentMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("agent_message_session_created_idx").on(table.sessionId, table.createdAt)]
);

export const agentRuns = pgTable(
  "agent_run",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    userMessageId: uuid("user_message_id")
      .notNull()
      .references(() => agentMessages.id, { onDelete: "cascade" }),
    assistantMessageId: uuid("assistant_message_id").references(() => agentMessages.id, {
      onDelete: "set null"
    }),
    status: agentRunStatusEnum("status").notNull(),
    answerMode: text("answer_mode").$type<"generated" | "extractive_fallback">(),
    insufficientEvidence: boolean("insufficient_evidence"),
    searchedPages: integer("searched_pages").notNull().default(0),
    embeddingCalls: integer("embedding_calls").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [index("agent_run_session_created_idx").on(table.sessionId, table.createdAt)]
);

export const agentEvidenceSnapshots = pgTable(
  "agent_evidence_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id").notNull(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => knowledgeSpaces.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    pageTitle: text("page_title").notNull(),
    pageType: text("page_type").notNull(),
    rank: integer("rank").notNull(),
    sourceCount: integer("source_count").notNull(),
    sourceRefs: jsonb("source_refs").$type<string[]>().notNull().default([]),
    cited: boolean("cited").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_evidence_run_rank_unique").on(table.agentRunId, table.rank),
    index("agent_evidence_run_idx").on(table.agentRunId)
  ]
);

export const agentToolCalls = pgTable(
  "agent_tool_call",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    name: text("name").$type<"knowledge.search" | "knowledge.read">().notNull(),
    bindingIds: jsonb("binding_ids").$type<string[]>().notNull().default([]),
    inputSummary: text("input_summary").notNull(),
    outputSummary: text("output_summary").notNull(),
    resultCount: integer("result_count").notNull(),
    searchedPages: integer("searched_pages").notNull(),
    durationMs: integer("duration_ms").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull()
  },
  (table) => [
    uniqueIndex("agent_tool_call_run_name_unique").on(table.agentRunId, table.name),
    index("agent_tool_call_run_completed_idx").on(table.agentRunId, table.completedAt)
  ]
);

export const agentRunEvents = pgTable(
  "agent_run_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentRunId: uuid("agent_run_id")
      .notNull()
      .references(() => agentRuns.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    type: text("type")
      .$type<
        | "run.started"
        | "tool.requested"
        | "tool.completed"
        | "run.completed"
        | "run.failed"
        | "run.stopped"
      >()
      .notNull(),
    tool: text("tool").$type<"knowledge.search" | "knowledge.read">(),
    inputSummary: text("input_summary"),
    outputSummary: text("output_summary"),
    status: agentRunStatusEnum("status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("agent_run_event_sequence_unique").on(table.agentRunId, table.sequence),
    index("agent_run_event_run_created_idx").on(table.agentRunId, table.createdAt)
  ]
);

export const skillApprovals = pgTable(
  "skill_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    skillVersion: text("skill_version").notNull(),
    skillDigest: text("skill_digest").notNull(),
    bindingIds: jsonb("binding_ids").$type<string[]>().notNull().default([]),
    inputSummary: text("input_summary").notNull(),
    status: skillApprovalStatusEnum("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("skill_approval_session_created_idx").on(table.sessionId, table.createdAt),
    index("skill_approval_user_status_idx").on(table.userId, table.status)
  ]
);

export const skillRuns = pgTable(
  "skill_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    skillId: text("skill_id").notNull(),
    skillVersion: text("skill_version").notNull(),
    skillDigest: text("skill_digest").notNull(),
    bindingIds: jsonb("binding_ids").$type<string[]>().notNull().default([]),
    approvalId: uuid("approval_id").references(() => skillApprovals.id, { onDelete: "set null" }),
    inputSummary: text("input_summary").notNull(),
    status: skillRunStatusEnum("status").notNull().default("queued"),
    errorCode: text("error_code"),
    outputSummary: jsonb("output_summary").$type<Record<string, unknown>>(),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true })
  },
  (table) => [
    index("skill_run_session_created_idx").on(table.sessionId, table.queuedAt),
    index("skill_run_user_status_idx").on(table.userId, table.status)
  ]
);

export const learningGenerationRequests = pgTable(
  "learning_generation_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillRunId: uuid("skill_run_id")
      .notNull()
      .references(() => skillRuns.id, { onDelete: "cascade" })
      .unique(),
    kind: text("kind").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull(),
    ...timestamps
  },
  (table) => [index("learning_generation_request_kind_created_idx").on(table.kind, table.createdAt)]
);

export const skillRunOutbox = pgTable(
  "skill_run_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillRunId: uuid("skill_run_id")
      .notNull()
      .references(() => skillRuns.id, { onDelete: "cascade" }),
    status: jobOutboxStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchToken: text("dispatch_token"),
    dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", { withTimezone: true }),
    queueJobId: uuid("queue_job_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("skill_run_outbox_run_unique").on(table.skillRunId),
    index("skill_run_outbox_dispatch_idx").on(
      table.status,
      table.dispatchLeaseExpiresAt,
      table.createdAt
    )
  ]
);

export const learnerProfiles = pgTable("learner_profile", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" })
    .unique(),
  declared: jsonb("declared").$type<Record<string, unknown>>().notNull().default({}),
  observed: jsonb("observed").$type<Record<string, unknown>>().notNull().default({}),
  inferred: jsonb("inferred").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps
});

export const learningPlans = pgTable(
  "learning_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learnerProfileId: uuid("learner_profile_id")
      .notNull()
      .references(() => learnerProfiles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: learningPlanStatusEnum("status").notNull().default("draft"),
    title: text("title").notNull(),
    plan: jsonb("plan").$type<Record<string, unknown>>().notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("learning_plan_version_unique").on(table.learnerProfileId, table.version)]
);

export const planComposeCandidates = pgTable(
  "plan_compose_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillRunId: uuid("skill_run_id")
      .notNull()
      .references(() => skillRuns.id, { onDelete: "cascade" })
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidate: jsonb("candidate").$type<Record<string, unknown>>().notNull(),
    materializedLearningPlanId: uuid("materialized_learning_plan_id").references(
      () => learningPlans.id,
      { onDelete: "set null" }
    ),
    ...timestamps
  },
  (table) => [
    index("plan_compose_candidate_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("plan_compose_candidate_materialized_plan_unique").on(
      table.materializedLearningPlanId
    )
  ]
);

export const courses = pgTable(
  "course",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    learningPlanId: uuid("learning_plan_id")
      .notNull()
      .references(() => learningPlans.id, { onDelete: "cascade" })
      .unique(),
    status: courseStatusEnum("status").notNull().default("active"),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("course_status_created_idx").on(table.status, table.createdAt)]
);

export const courseModules = pgTable(
  "course_module",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("course_module_ordinal_unique").on(table.courseId, table.ordinal)]
);

export const courseUnits = pgTable(
  "course_unit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseModuleId: uuid("course_module_id")
      .notNull()
      .references(() => courseModules.id, { onDelete: "cascade" }),
    planUnitId: text("plan_unit_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    objective: text("objective").notNull(),
    completionRule: text("completion_rule").notNull(),
    resourceVersionId: uuid("resource_version_id")
      .notNull()
      .references(() => resourceVersions.id, { onDelete: "cascade" }),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("course_unit_plan_unit_unique").on(table.courseModuleId, table.planUnitId),
    uniqueIndex("course_unit_ordinal_unique").on(table.courseModuleId, table.ordinal)
  ]
);

export const courseKnowledgePoints = pgTable(
  "course_knowledge_point",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseUnitId: uuid("course_unit_id")
      .notNull()
      .references(() => courseUnits.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    title: text("title").notNull(),
    statement: text("statement").notNull(),
    resourceVersionId: uuid("resource_version_id")
      .notNull()
      .references(() => resourceVersions.id, { onDelete: "cascade" }),
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [uniqueIndex("course_kp_ordinal_unique").on(table.courseUnitId, table.ordinal)]
);

export const practiceSets = pgTable(
  "practice_set",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: practiceSetStatusEnum("status").notNull().default("candidate"),
    difficulty: practiceDifficultyEnum("difficulty").notNull(),
    generation: text("generation").notNull().default("deterministic_template"),
    skillRunId: uuid("skill_run_id").references(() => skillRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("practice_set_user_course_created_idx").on(table.userId, table.courseId, table.createdAt)
  ]
);

export const practiceGenerateCandidates = pgTable(
  "practice_generate_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    skillRunId: uuid("skill_run_id")
      .notNull()
      .references(() => skillRuns.id, { onDelete: "cascade" })
      .unique(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    candidate: jsonb("candidate").$type<Record<string, unknown>>().notNull(),
    materializedPracticeSetId: uuid("materialized_practice_set_id").references(
      () => practiceSets.id,
      { onDelete: "set null" }
    ),
    ...timestamps
  },
  (table) => [
    index("practice_generate_candidate_user_created_idx").on(table.userId, table.createdAt),
    uniqueIndex("practice_generate_candidate_materialized_set_unique").on(
      table.materializedPracticeSetId
    )
  ]
);

export const practiceQuestions = pgTable(
  "practice_question",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    practiceSetId: uuid("practice_set_id")
      .notNull()
      .references(() => practiceSets.id, { onDelete: "cascade" }),
    courseUnitId: uuid("course_unit_id")
      .notNull()
      .references(() => courseUnits.id, { onDelete: "cascade" }),
    knowledgePointId: uuid("knowledge_point_id")
      .notNull()
      .references(() => courseKnowledgePoints.id, { onDelete: "restrict" }),
    resourceVersionId: uuid("resource_version_id")
      .notNull()
      .references(() => resourceVersions.id, { onDelete: "cascade" }),
    sourceRef: text("source_ref").notNull(),
    version: integer("version").notNull().default(1),
    answerType: text("answer_type").notNull().default("free_response"),
    answerKey: text("answer_key"),
    prompt: text("prompt").notNull(),
    rubric: jsonb("rubric").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("practice_question_set_created_idx").on(table.practiceSetId, table.createdAt),
    index("practice_question_knowledge_point_idx").on(table.knowledgePointId)
  ]
);

export const practiceAttempts = pgTable(
  "practice_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    practiceQuestionId: uuid("practice_question_id")
      .notNull()
      .references(() => practiceQuestions.id, { onDelete: "cascade" }),
    courseUnitId: uuid("course_unit_id").notNull(),
    knowledgePointId: uuid("knowledge_point_id").notNull(),
    resourceVersionId: uuid("resource_version_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    questionVersion: integer("question_version").notNull(),
    prompt: text("prompt").notNull(),
    rubric: jsonb("rubric").$type<Record<string, unknown>>().notNull(),
    response: text("response").notNull(),
    answerKey: text("answer_key"),
    status: practiceAttemptStatusEnum("status").notNull().default("pending_review"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("practice_attempt_user_question_submitted_idx").on(
      table.userId,
      table.practiceQuestionId,
      table.submittedAt
    ),
    index("practice_attempt_user_course_submitted_idx").on(table.userId, table.submittedAt)
  ]
);

export const practiceGrades = pgTable(
  "practice_grade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => practiceAttempts.id, { onDelete: "cascade" }),
    grader: text("grader").notNull(),
    ruleVersion: text("rule_version").notNull(),
    score: integer("score").notNull(),
    maximumScore: integer("maximum_score").notNull(),
    correct: boolean("correct").notNull(),
    reviewerUserId: uuid("reviewer_user_id"),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("practice_grade_attempt_unique").on(table.attemptId),
    index("practice_grade_created_idx").on(table.createdAt)
  ]
);

export const assessments = pgTable(
  "assessment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    practiceSetId: uuid("practice_set_id")
      .notNull()
      .references(() => practiceSets.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: assessmentStatusEnum("status").notNull().default("draft"),
    title: text("title").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("assessment_user_course_created_idx").on(table.userId, table.courseId, table.createdAt),
    uniqueIndex("assessment_practice_set_unique").on(table.practiceSetId)
  ]
);

export const assessmentQuestions = pgTable(
  "assessment_question",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    sourcePracticeQuestionId: uuid("source_practice_question_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    courseUnitId: uuid("course_unit_id").notNull(),
    knowledgePointId: uuid("knowledge_point_id").notNull(),
    resourceVersionId: uuid("resource_version_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    questionVersion: integer("question_version").notNull(),
    answerType: text("answer_type").notNull(),
    answerKey: text("answer_key"),
    prompt: text("prompt").notNull(),
    rubric: jsonb("rubric").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("assessment_question_ordinal_unique").on(table.assessmentId, table.ordinal),
    index("assessment_question_assessment_idx").on(table.assessmentId)
  ]
);

export const assessmentAttempts = pgTable(
  "assessment_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assessmentId: uuid("assessment_id")
      .notNull()
      .references(() => assessments.id, { onDelete: "cascade" }),
    assessmentQuestionId: uuid("assessment_question_id")
      .notNull()
      .references(() => assessmentQuestions.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    courseUnitId: uuid("course_unit_id").notNull(),
    knowledgePointId: uuid("knowledge_point_id").notNull(),
    resourceVersionId: uuid("resource_version_id").notNull(),
    sourceRef: text("source_ref").notNull(),
    questionVersion: integer("question_version").notNull(),
    prompt: text("prompt").notNull(),
    rubric: jsonb("rubric").$type<Record<string, unknown>>().notNull(),
    response: text("response").notNull(),
    answerKey: text("answer_key"),
    status: practiceAttemptStatusEnum("status").notNull().default("pending_review"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("assessment_attempt_question_unique").on(table.assessmentQuestionId),
    index("assessment_attempt_user_assessment_idx").on(table.userId, table.assessmentId)
  ]
);

export const assessmentGrades = pgTable(
  "assessment_grade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => assessmentAttempts.id, { onDelete: "cascade" }),
    grader: text("grader").notNull(),
    ruleVersion: text("rule_version").notNull(),
    score: integer("score").notNull(),
    maximumScore: integer("maximum_score").notNull(),
    correct: boolean("correct").notNull(),
    reviewerUserId: uuid("reviewer_user_id"),
    rationale: text("rationale"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("assessment_grade_attempt_unique").on(table.attemptId),
    index("assessment_grade_created_idx").on(table.createdAt)
  ]
);

export const learningEvents = pgTable(
  "learning_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    verb: text("verb").notNull(),
    object: text("object").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull().default({}),
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [index("learning_event_user_created_idx").on(table.userId, table.createdAt)]
);

export const masterySnapshots = pgTable(
  "mastery_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    knowledgePointId: text("knowledge_point_id").notNull(),
    gradeId: uuid("grade_id"),
    score: real("score").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    index("mastery_user_kp_idx").on(table.userId, table.knowledgePointId),
    uniqueIndex("mastery_grade_unique").on(table.gradeId)
  ]
);

export const learningReportSnapshots = pgTable(
  "learning_report_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    learningPlanId: uuid("learning_plan_id")
      .notNull()
      .references(() => learningPlans.id, { onDelete: "cascade" }),
    courseId: uuid("course_id")
      .notNull()
      .references(() => courses.id, { onDelete: "cascade" }),
    report: jsonb("report").$type<LearningProgressReport>().notNull(),
    status: learningReportStatusEnum("status").notNull().default("queued"),
    executionToken: text("execution_token"),
    executionLeaseExpiresAt: timestamp("execution_lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    index("learning_report_user_course_created_idx").on(
      table.userId,
      table.courseId,
      table.createdAt
    ),
    index("learning_report_status_lease_idx").on(table.status, table.executionLeaseExpiresAt)
  ]
);

export const learningReportArtifacts = pgTable(
  "learning_report_artifact",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => learningReportSnapshots.id, { onDelete: "cascade" }),
    format: learningReportArtifactFormatEnum("format").notNull(),
    blobUri: text("blob_uri").notNull(),
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("learning_report_artifact_snapshot_format_unique").on(
      table.snapshotId,
      table.format
    ),
    index("learning_report_artifact_snapshot_idx").on(table.snapshotId)
  ]
);

export const learningReportOutbox = pgTable(
  "learning_report_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => learningReportSnapshots.id, { onDelete: "cascade" }),
    status: jobOutboxStatusEnum("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    dispatchToken: text("dispatch_token"),
    dispatchLeaseExpiresAt: timestamp("dispatch_lease_expires_at", { withTimezone: true }),
    queueJobId: uuid("queue_job_id"),
    lastErrorCode: text("last_error_code"),
    lastErrorAt: timestamp("last_error_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    ...timestamps
  },
  (table) => [
    uniqueIndex("learning_report_outbox_snapshot_unique").on(table.snapshotId),
    index("learning_report_outbox_dispatch_idx").on(
      table.status,
      table.dispatchLeaseExpiresAt,
      table.createdAt
    )
  ]
);

export const agentSkillInstallations = pgTable(
  "agent_skill_installation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    skillName: text("skill_name").notNull(),
    version: text("version").notNull(),
    digest: text("digest").notNull(),
    sourceFormat: text("source_format").notNull(),
    sourceVersion: text("source_version"),
    sourceDigest: text("source_digest"),
    publisher: text("publisher").notNull(),
    installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean("enabled").notNull().default(true),
    executable: boolean("executable").notNull().default(false)
  },
  (table) => [
    uniqueIndex("agent_skill_installation_enabled_unique")
      .on(table.organizationId, table.skillName)
      .where(sql`enabled`),
    index("agent_skill_installation_history_idx").on(
      table.organizationId,
      table.skillName,
      table.installedAt
    )
  ]
);
