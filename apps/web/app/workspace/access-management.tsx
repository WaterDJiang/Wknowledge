"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Role } from "@wknowledge/contracts";
import { useWorkspace } from "./workspace-shell";

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  disabled: boolean;
  role: Role;
}

interface Invitation {
  id: string;
  email: string;
  organizationRole: Role;
  spaceId: string | null;
  spaceRole: Role | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}

type SpaceMember = ManagedUser;

const roles: Array<Exclude<Role, "owner">> = ["admin", "editor", "learner", "viewer"];
const roleLabel: Record<Role, string> = {
  owner: "所有者",
  admin: "管理员",
  editor: "编辑者",
  learner: "学习者",
  viewer: "访问者"
};

async function message(response: Response, fallback: string) {
  const data = (await response.json().catch(() => null)) as { message?: string } | null;
  return data?.message ?? fallback;
}

async function readAccessManagement(spaceId: string) {
  const results = await Promise.all([
    fetch("/api/settings/users"),
    fetch("/api/settings/invitations"),
    spaceId ? fetch(`/api/spaces/${spaceId}/members`) : Promise.resolve(null)
  ]);
  const [usersResponse, invitationsResponse, membersResponse] = results;
  if (!usersResponse.ok || !invitationsResponse.ok || (membersResponse && !membersResponse.ok))
    throw new Error("ACCESS_MANAGEMENT_LOAD_FAILED");
  const [userData, invitationData, memberData] = await Promise.all([
    usersResponse.json() as Promise<{ users: ManagedUser[] }>,
    invitationsResponse.json() as Promise<{ invitations: Invitation[] }>,
    membersResponse ? (membersResponse.json() as Promise<{ members: SpaceMember[] }>) : null
  ]);
  return {
    users: userData.users,
    invitations: invitationData.invitations,
    members: memberData?.members ?? []
  };
}

export function AccessManagement() {
  const { activeId, activeSpace, activeRole, setNotice } = useWorkspace();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [busy, setBusy] = useState("");
  const [inviteUrl, setInviteUrl] = useState("");
  const [error, setError] = useState("");
  const canManageSpace = activeRole === "owner" || activeRole === "admin";

  const applyAccess = (data: Awaited<ReturnType<typeof readAccessManagement>>) => {
    setUsers(data.users);
    setInvitations(data.invitations);
    setMembers(data.members);
  };

  const load = async () => applyAccess(await readAccessManagement(activeId));

  useEffect(() => {
    void readAccessManagement(activeId)
      .then((data) => {
        setUsers(data.users);
        setInvitations(data.invitations);
        setMembers(data.members);
      })
      .catch(() => setError("成员与邀请读取失败"));
  }, [activeId]);

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy("invite");
    setError("");
    const response = await fetch("/api/settings/invitations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: form.get("email"),
        organizationRole: form.get("organizationRole"),
        ...(activeId ? { spaceId: activeId, spaceRole: form.get("spaceRole") } : {})
      })
    });
    if (!response.ok) setError(await message(response, "邀请创建失败"));
    else {
      const data = (await response.json()) as { acceptUrl: string };
      setInviteUrl(data.acceptUrl);
      event.currentTarget.reset();
      await load();
      setNotice("邀请已创建，请通过私有渠道发送链接");
    }
    setBusy("");
  }

  async function toggleUser(user: ManagedUser) {
    setBusy(user.id);
    const response = await fetch(`/api/settings/users/${user.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: !user.disabled })
    });
    if (!response.ok) setError(await message(response, "用户状态更新失败"));
    else {
      await load();
      setNotice(user.disabled ? "用户已重新启用" : "用户已禁用，既有会话已撤销");
    }
    setBusy("");
  }

  async function revoke(invitationId: string) {
    setBusy(invitationId);
    const response = await fetch(`/api/settings/invitations/${invitationId}`, { method: "DELETE" });
    if (!response.ok) setError(await message(response, "邀请撤销失败"));
    else {
      await load();
      setNotice("邀请已撤销");
    }
    setBusy("");
  }

  async function updateMember(member: SpaceMember, role: Exclude<Role, "owner">) {
    setBusy(member.id);
    const response = await fetch(`/api/spaces/${activeId}/members/${member.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role })
    });
    if (!response.ok) setError(await message(response, "成员角色更新失败"));
    else {
      await load();
      setNotice("空间成员角色已更新");
    }
    setBusy("");
  }

  async function removeMember(member: SpaceMember) {
    setBusy(member.id);
    const response = await fetch(`/api/spaces/${activeId}/members/${member.id}`, {
      method: "DELETE"
    });
    if (!response.ok) setError(await message(response, "空间成员移除失败"));
    else {
      await load();
      setNotice("已移除空间成员");
    }
    setBusy("");
  }

  return (
    <section className="panel settings-panel" aria-labelledby="access-heading">
      <div className="panel-head settings-panel-head">
        <div>
          <span>04</span>
          <h2 id="access-heading">成员与访问</h2>
        </div>
        <small>Private invitation · space RBAC</small>
      </div>
      {error ? <p className="form-error">{error}</p> : null}
      <form className="provider-create access-invite-form" onSubmit={invite}>
        <label>
          邀请邮箱
          <input name="email" type="email" required placeholder="member@company.com" />
        </label>
        <label>
          组织角色
          <select name="organizationRole" defaultValue="viewer">
            {roles.map((role) => (
              <option key={role} value={role}>
                {roleLabel[role]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {activeSpace ? `${activeSpace.name} 中的角色` : "空间角色"}
          <select name="spaceRole" defaultValue="viewer" disabled={!activeId}>
            {roles.slice(1).map((role) => (
              <option key={role} value={role}>
                {roleLabel[role]}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy === "invite"}>
          {busy === "invite" ? "创建中…" : "创建邀请链接"}
        </button>
      </form>
      {inviteUrl ? (
        <div className="invitation-link" role="status">
          <span>仅此一次显示，请通过私有渠道发送：</span>
          <code>{inviteUrl}</code>
        </div>
      ) : null}
      <div className="access-grid">
        <article>
          <h3>组织用户</h3>
          {users.map((user) => (
            <div className="access-row" key={user.id}>
              <div>
                <b>{user.name}</b>
                <small>
                  {user.email} · {roleLabel[user.role]}
                </small>
              </div>
              <button
                className="button-quiet"
                disabled={busy === user.id || user.role === "owner"}
                onClick={() => void toggleUser(user)}
              >
                {user.disabled ? "启用" : "禁用"}
              </button>
            </div>
          ))}
        </article>
        <article>
          <h3>待处理邀请</h3>
          {invitations.filter((item) => !item.acceptedAt && !item.revokedAt).length ? (
            invitations
              .filter((item) => !item.acceptedAt && !item.revokedAt)
              .map((invitation) => (
                <div className="access-row" key={invitation.id}>
                  <div>
                    <b>{invitation.email}</b>
                    <small>到期 {new Date(invitation.expiresAt).toLocaleDateString("zh-CN")}</small>
                  </div>
                  <button
                    className="button-quiet"
                    disabled={busy === invitation.id}
                    onClick={() => void revoke(invitation.id)}
                  >
                    撤销
                  </button>
                </div>
              ))
          ) : (
            <p className="settings-empty">没有待处理邀请。</p>
          )}
        </article>
      </div>
      <article className="space-member-list">
        <h3>{activeSpace ? `${activeSpace.name} 的成员` : "选择知识空间后管理成员"}</h3>
        {members.map((member) => (
          <div className="access-row" key={member.id}>
            <div>
              <b>{member.name}</b>
              <small>{member.email}</small>
            </div>
            {member.role === "owner" ? (
              <span className="status-chip enabled">所有者</span>
            ) : (
              <div className="member-actions">
                <select
                  aria-label={`${member.name} 的空间角色`}
                  defaultValue={member.role}
                  disabled={!canManageSpace || busy === member.id}
                  onChange={(event) =>
                    void updateMember(member, event.currentTarget.value as Exclude<Role, "owner">)
                  }
                >
                  {roles.slice(1).map((role) => (
                    <option key={role} value={role}>
                      {roleLabel[role]}
                    </option>
                  ))}
                </select>
                <button
                  className="button-quiet"
                  disabled={!canManageSpace || busy === member.id}
                  onClick={() => void removeMember(member)}
                >
                  移除
                </button>
              </div>
            )}
          </div>
        ))}
      </article>
    </section>
  );
}
