import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ideSelections, resolveWorkspace, workspaceOptions, type WorkspaceOption } from "../src/workspaces"
import { fakeJwt } from "./support"

const A: WorkspaceOption = { organizationId: "org-a", workspaceId: "ws-a" }
const B: WorkspaceOption = { organizationId: "org-b", workspaceId: "ws-b" }

test("lists the workspaces of every organization membership", () => {
  const jwt = fakeJwt({
    orgMemberships: [
      { orgId: "org-a", orgName: "Org A", workspaces: [{ id: "ws-a", name: "Main" }, { id: "ws-a2" }] },
      { orgId: "org-b", workspaces: [] },
      { workspaces: [{ id: "orphan" }] },
    ],
  })

  expect(workspaceOptions(jwt)).toEqual([
    { organizationId: "org-a", organizationName: "Org A", workspaceId: "ws-a", workspaceName: "Main" },
    { organizationId: "org-a", organizationName: "Org A", workspaceId: "ws-a2", workspaceName: undefined },
  ])
})

test("reads the Air workspace selection from other.xml of the newest IntelliJ IDEA", async () => {
  const root = await mkdtemp(join(tmpdir(), "jcp-tank-"))
  const write = async (ide: string, userId: string, workspaceId: string) => {
    await mkdir(join(root, ide, "options"), { recursive: true })
    const json = JSON.stringify({ selections: { [userId]: { organizationId: "org", workspaceId } } }, null, 2)
    const xml = `<application>\n  <component name="AirJcpWorkspaceSelection">${json.replaceAll("\"", "&quot;")}</component>\n</application>`
    await writeFile(join(root, ide, "options", "other.xml"), xml)
  }
  await write("IntelliJIdea2026.2", "user-1", "old")
  await write("IntelliJIdea2026.3", "user-1", "new")
  await write("PyCharm2026.3", "user-1", "other-product")

  expect(await ideSelections(root)).toEqual([
    { ide: "IntelliJIdea2026.3", userId: "user-1", organizationId: "org", workspaceId: "new" },
    { ide: "IntelliJIdea2026.2", userId: "user-1", organizationId: "org", workspaceId: "old" },
  ])
})

test("prefers the requested workspace, then the IDE selection of the same user, then the only one", () => {
  const selection = (userId: string, workspaceId: string) => ({ ide: "IntelliJIdea2026.3", userId, organizationId: "org", workspaceId })

  expect(resolveWorkspace([A, B], "ws-b", [selection("me", "ws-a")], "me")).toMatchObject({ kind: "chosen", workspace: B })
  expect(resolveWorkspace([A, B], undefined, [selection("other", "ws-b"), selection("me", "ws-a")], "me")).toMatchObject({ kind: "chosen", workspace: A })
  expect(resolveWorkspace([A], undefined, [], "me")).toMatchObject({ kind: "chosen", workspace: A })
  expect(resolveWorkspace([A, B], undefined, [], "me")).toEqual({ kind: "ambiguous", options: [A, B] })
  expect(resolveWorkspace([], undefined, [], "me")).toEqual({ kind: "none" })
  expect(() => resolveWorkspace([A], "missing", [], "me")).toThrow("no workspace missing")
})
