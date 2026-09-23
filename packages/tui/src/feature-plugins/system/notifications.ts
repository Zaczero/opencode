import { Plugin } from "@opencode/plugin/tui"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"

function notify(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void context.attention.notify({
    title: title ?? session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    const errored = new Set<string>()
    const forms = new Set<string>()
    const permissions = new Set<string>()

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id)) return
        forms.add(event.data.form.id)
        notify(context, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
      }),
      context.data.on("form.replied", (event) => forms.delete(event.data.id)),
      context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id)) return
        permissions.add(event.data.id)
        notify(context, event.data.sessionID, "Permission needs input", "permission")
      }),
      context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
      context.data.on("session.execution.started", (event) => errored.delete(event.data.sessionID)),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (errored.has(sessionID)) return
        errored.add(sessionID)
        notify(context, sessionID, event.data.error.message, "error")
        context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
      }),
      // An execution can end while shells or subagents it started keep working and will wake it again;
      // only settling means the session is done. A failure already reported stands in for its settle.
      context.data.session.onSettled((sessionID) => {
        if (errored.delete(sessionID)) return
        const session = context.data.session.get(sessionID)
        notify(context, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
      }),
    ]

    return () => dispose.reverse().forEach((cleanup) => cleanup())
  },
})
