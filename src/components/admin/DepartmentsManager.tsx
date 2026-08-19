'use client';

import { useState, useEffect, useCallback } from 'react';

interface DepartmentNode {
  id: string;
  name: string;
  parent_id: string | null;
  description: string | null;
  userCount: number;
  agentCount: number;
  children: DepartmentNode[];
}

/** 트리를 평면 목록으로 (상위 부서 선택 드롭다운용) */
function flatten(nodes: DepartmentNode[], depth = 0): { node: DepartmentNode; depth: number }[] {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

/** 어떤 부서의 하위 부서 id 전체 (자기 자신 포함) — 상위 부서 선택에서 제외할 대상 */
function subtreeIds(node: DepartmentNode): string[] {
  return [node.id, ...node.children.flatMap(subtreeIds)];
}

export default function DepartmentsManager() {
  const [tree, setTree] = useState<DepartmentNode[]>([]);
  const [myDepartmentId, setMyDepartmentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [newName, setNewName] = useState('');
  const [newParentId, setNewParentId] = useState('');
  // 기관 직속 부서의 관리자만 최상위 부서를 만들거나 그리로 옮길 수 있다.
  // 권한이 없는데 선택지를 보여주면 고른 뒤 403을 보게 된다.
  const [canCreateRoot, setCanCreateRoot] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editParentId, setEditParentId] = useState('');

  const load = useCallback(async () => {
    const res = await fetch('/api/departments');
    const result = await res.json();
    if (result.ok) {
      setTree(result.data ?? []);
      setMyDepartmentId(result.meta?.myDepartmentId ?? null);
      setCanCreateRoot(Boolean(result.meta?.canCreateRoot));
    } else {
      setError(result.error?.message ?? '부서 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  // '(최상위 부서)'를 숨기면 빈 값에 대응하는 선택지가 없어진다. 그대로 두면
  // 화면에는 첫 부서가 보이는데 실제로 보내는 값은 빈 값이라 403이 난다.
  // 자기 부서를 기본값으로 맞춰 보이는 것과 보내는 것을 일치시킨다.
  useEffect(() => {
    if (!canCreateRoot && !newParentId && myDepartmentId) {
      setNewParentId(myDepartmentId);
    }
  }, [canCreateRoot, newParentId, myDepartmentId]);

  const flat = flatten(tree);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName, parent_id: newParentId || null }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setNewName('');
      setNewParentId(canCreateRoot ? '' : (myDepartmentId ?? ''));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '부서 생성에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const handleUpdate = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/departments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, parent_id: editParentId || null }),
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '부서 수정에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (node: DepartmentNode) => {
    if (!confirm(`'${node.name}' 부서를 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/departments/${node.id}`, { method: 'DELETE' });
      const result = await res.json();
      if (!result.ok) throw new Error(result.error?.message);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '부서 삭제에 실패했습니다.');
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (node: DepartmentNode) => {
    setEditingId(node.id);
    setEditName(node.name);
    setEditParentId(node.parent_id ?? '');
    setError(null);
  };

  const renderNode = (node: DepartmentNode, depth: number) => {
    const isEditing = editingId === node.id;
    const isMine = node.id === myDepartmentId;
    // 자기 자신과 하위 부서는 상위로 지정할 수 없다 (트리가 끊어진 고리가 된다)
    const excluded = new Set(subtreeIds(node));

    return (
      <div key={node.id}>
        <div
          className="flex items-center gap-3 py-2.5 px-3 border-b border-slate-100 hover:bg-slate-50"
          style={{ paddingLeft: `${depth * 20 + 12}px` }}
        >
          {isEditing ? (
            <div className="flex-1 flex flex-wrap items-center gap-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
              />
              <select
                value={editParentId}
                onChange={(e) => setEditParentId(e.target.value)}
                className="px-2.5 py-1.5 border border-slate-200 rounded-lg text-sm bg-white"
              >
                {canCreateRoot && <option value="">(최상위 부서)</option>}
                {flat
                  .filter(({ node: n }) => !excluded.has(n.id))
                  .map(({ node: n, depth: d }) => (
                    <option key={n.id} value={n.id}>
                      {' '.repeat(d * 2)}
                      {n.name}
                    </option>
                  ))}
              </select>
              <button
                onClick={() => handleUpdate(node.id)}
                disabled={busy}
                className="px-3 py-1.5 bg-[#003087] text-white text-xs font-semibold rounded-lg disabled:bg-slate-300"
              >
                저장
              </button>
              <button
                onClick={() => setEditingId(null)}
                className="px-3 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600"
              >
                취소
              </button>
            </div>
          ) : (
            <>
              <span className="text-slate-300 text-xs select-none">
                {depth > 0 ? '└' : '●'}
              </span>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium text-slate-900">{node.name}</span>
                {isMine && (
                  <span className="ml-2 text-[10px] px-1.5 py-0.5 bg-[#003087]/10 text-[#003087] rounded font-medium">
                    내 소속
                  </span>
                )}
                <span className="ml-2 text-xs text-slate-400">
                  직원 {node.userCount} · 비서 {node.agentCount}
                </span>
              </div>
              <button
                onClick={() => startEdit(node)}
                className="px-2.5 py-1 text-xs border border-slate-200 rounded-lg hover:bg-white text-slate-600"
              >
                수정
              </button>
              <button
                onClick={() => handleDelete(node)}
                disabled={busy || isMine}
                className="px-2.5 py-1 text-xs border border-red-200 text-red-500 rounded-lg hover:bg-red-50 disabled:opacity-40"
              >
                삭제
              </button>
            </>
          )}
        </div>
        {node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <section className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">부서 관리</h1>
        <p className="text-sm text-slate-500 mt-1">
          기관의 부서 구조를 관리합니다. <strong>상위 부서에 등록한 비서와 문서는 하위 부서가 모두 사용</strong>합니다.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>
      )}

      <form onSubmit={handleCreate} className="flex flex-wrap items-center gap-2 p-4 bg-white border border-slate-100 rounded-xl">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="새 부서명 (예: 기획예산과)"
          className="flex-1 min-w-[200px] px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-[#003087]/20"
        />
        <select
          value={newParentId}
          onChange={(e) => setNewParentId(e.target.value)}
          className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white"
        >
          {canCreateRoot && <option value="">(최상위 부서)</option>}
          {flat.map(({ node, depth }) => (
            <option key={node.id} value={node.id}>
              {' '.repeat(depth * 2)}
              {node.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !newName.trim()}
          className="px-4 py-2 bg-[#003087] hover:bg-[#002070] text-white text-sm font-semibold rounded-xl disabled:bg-slate-300"
        >
          부서 추가
        </button>
      </form>

      <div className="bg-white border border-slate-100 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-400">불러오는 중...</div>
        ) : tree.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-400">등록된 부서가 없습니다.</div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>

      <p className="text-xs text-slate-400">
        하위 부서·소속 직원·비서가 남아 있는 부서는 삭제할 수 없습니다. 먼저 옮기거나 정리해주세요.
      </p>
    </section>
  );
}
