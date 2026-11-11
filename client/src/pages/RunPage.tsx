import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { canRedrive } from "@ratchet/engine/utils";
import { isRunFinished } from "../utils/runs";
import {
  fetchEvents,
  fetchRun,
  redriveRun,
} from "../services/workflows.service";
import type { Step } from "@ratchet/api/types";
import { FAILURE_REASON_LABELS } from "../constants/statuses";
import { stepDisplayStatus } from "../utils/steps";
import { FlowDiagram } from "../components/FlowDiagram";
import { Button } from "../components/Button";
import { Elapsed } from "../components/Elapsed";
import { EventPill } from "../components/EventPill";
import { StatusBadge } from "../components/StatusBadge";
import { StepStatusBadge } from "../components/StepStatusBadge";
import { ErrorMessage } from "../components/ErrorMessage";
import { Panel } from "../components/Panel";
import { URLS } from "../urls";

function StepDetail({ step }: { step: Step }) {
  return (
    <Panel>
      <h2 className="mb-3 font-semibold">{step.title}</h2>
      {step.description && (
        <p className="-mt-1.5 mb-3 text-muted">{step.description}</p>
      )}
      <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-3 gap-y-1.5 [&_dt]:text-muted">
        <dt>Status</dt>
        <dd>
          <StepStatusBadge status={stepDisplayStatus(step)} />
        </dd>
        {step.failure_reason && (
          <>
            <dt>Reason</dt>
            <dd>{FAILURE_REASON_LABELS[step.failure_reason]}</dd>
          </>
        )}
        <dt>Attempt</dt>
        <dd>{step.attempt || "–"}</dd>
        <dt>Worker</dt>
        <dd className="font-mono text-[13px]">{step.worker_id ?? "–"}</dd>
        <dt>Duration</dt>
        <dd className="font-mono text-[13px]">
          <Elapsed start={step.started_at} end={step.finished_at} />
        </dd>
        {step.error && (
          <>
            {/* While retrying, the error is the last attempt's, not the step's result. */}
            <dt>{step.status === "failed" ? "Error" : "Last error"}</dt>
            <dd className="text-red">{step.error}</dd>
          </>
        )}
      </dl>
      {step.output != null && (
        <pre className="mt-3 overflow-x-auto rounded-md bg-grey-soft p-2.5 font-mono text-xs/normal">
          {JSON.stringify(step.output, null, 2)}
        </pre>
      )}
    </Panel>
  );
}

export function RunPage() {
  const { id = "" } = useParams();
  const [picked, setPicked] = useState<string | null>(null);

  const { data, error } = useQuery({
    queryKey: ["run", id],
    queryFn: () => fetchRun(id),
    retry: false,
    // Finished runs can't change, so stop polling them.
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = query.state.data?.run.status;
      return status && isRunFinished(status) ? false : 500;
    },
  });

  const finished = data ? isRunFinished(data.run.status) : false;
  const { data: events } = useQuery({
    queryKey: ["events", id, finished],
    queryFn: () => fetchEvents(id),
    enabled: !!data,
    refetchInterval: finished ? false : 500,
  });

  const queryClient = useQueryClient();
  const redrive = useMutation({
    mutationFn: () => redriveRun(id),
    // The run is running again, so start polling it and its history.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", id] }),
  });

  if (error) {
    return (
      <>
        <Link to={URLS.runs.list()}>← Runs</Link>
        <ErrorMessage>Could not load this run: {error.message}</ErrorMessage>
      </>
    );
  }
  if (!data) return <p className="p-8 text-center text-muted">Loading…</p>;

  const { run, steps } = data;
  const active = steps.find((s) => s.status === "running");
  const failed = steps.find((s) => s.status === "failed");
  const selected =
    steps.find((s) => s.name === picked) ?? active ?? failed ?? steps.at(-1)!;

  return (
    <>
      <Link to={URLS.runs.list()} className="mb-2.5 inline-block">
        ← Runs
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[22px] font-semibold">
          {run.workflow_title}{" "}
          <span className="font-mono text-[13px] text-muted">
            {run.id.slice(0, 8)}
          </span>
        </h1>
        <div className="flex items-center gap-2.5">
          <StatusBadge status={run.status} />
          {run.failure_reason && (
            <span className="text-[13px] text-muted">
              {FAILURE_REASON_LABELS[run.failure_reason]}
            </span>
          )}
          <span className="font-mono text-[13px]">
            <Elapsed start={run.started_at} end={run.finished_at} />
          </span>
          {canRedrive(run.status, run.failure_reason) && (
            <Button
              variant="primary"
              disabled={redrive.isPending}
              onClick={() => redrive.mutate()}
              title="Runs the steps that didn't succeed again, with fresh attempts. Steps that succeeded keep their results."
            >
              Resume from failed step
            </Button>
          )}
        </div>
      </div>
      {redrive.error && (
        <ErrorMessage>
          Could not resume this run: {redrive.error.message}
        </ErrorMessage>
      )}
      <p className="mt-0.5 mb-4 text-muted">{run.workflow_description}</p>

      <FlowDiagram
        steps={steps}
        selected={selected.name}
        onSelect={setPicked}
      />

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 max-[720px]:grid-cols-1">
        <StepDetail step={selected} />
        <Panel>
          <h2 className="mb-3 font-semibold">Events</h2>
          <ol>
            {events?.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-0.75"
              >
                <time className="font-mono text-[13px] text-muted">
                  {new Date(event.at).toLocaleTimeString()}
                </time>
                <EventPill type={event.type} />
                <span className="text-muted">
                  {[event.step_name, event.worker_id]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      </div>
    </>
  );
}
