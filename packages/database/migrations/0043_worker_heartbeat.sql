CREATE TABLE "worker_heartbeat" (
  "instance_id" text PRIMARY KEY NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "heartbeat_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
