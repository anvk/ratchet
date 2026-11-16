import type { ScheduleInfo } from "@ratchet/api/types";
import { Age } from "./Age";
import { Panel } from "./Panel";
import { Until } from "./Until";

/** Shared by every table cell. */
const CELL_CLASSES = "border-b border-line px-3.5 py-2.25 text-left";

/** The workflows' schedules and when each next fires. */
export function SchedulesPanel({ schedules }: { schedules: ScheduleInfo[] }) {
  return (
    <Panel className="mt-5 overflow-x-auto p-0">
      <h2 className="px-3.5 pt-3 pb-1 font-semibold">Schedules</h2>
      <table className="w-full whitespace-nowrap">
        <thead className="text-xs/normal text-muted [&_th]:font-medium">
          <tr>
            <th className={CELL_CLASSES}>Workflow</th>
            <th className={CELL_CLASSES}>Schedule</th>
            <th className={CELL_CLASSES}>
              Cron <span className="font-normal">(UTC)</span>
            </th>
            <th className={CELL_CLASSES}>Next run</th>
            <th className={CELL_CLASSES}>Last run</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((schedule) => (
            <tr key={`${schedule.workflow}/${schedule.name}`} className="last:*:border-b-0">
              <td className={CELL_CLASSES}>{schedule.workflow_title}</td>
              <td className={CELL_CLASSES}>{schedule.name}</td>
              <td className={`${CELL_CLASSES} font-mono text-[13px]`}>{schedule.cron}</td>
              <td className={CELL_CLASSES}>
                <Until at={schedule.next_fire_at} />
              </td>
              <td className={CELL_CLASSES}>
                <Age at={schedule.last_fired_at} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
