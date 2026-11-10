import type { StatusView } from '../lib/statusView'

export function StatusLabel({ view }: { view: StatusView }) {
  const Icon = view.icon
  return <span className={`status status-${view.tone}`}>
    <Icon size={14} aria-hidden="true" className={view.spinning ? 'spin' : undefined} />
    <span>{view.text}{view.percent !== undefined ? <> <span className="status-percent">{view.percent}%</span></> : null}{view.detail ? <span className="status-detail"> — {view.detail}</span> : null}</span>
  </span>
}
