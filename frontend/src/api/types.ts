export type Role = 'VIEWER' | 'MEMBER' | 'LEAD' | 'ADMIN';
export type ItemType = 'INCIDENT' | 'CUSTOMER_ISSUE' | 'PAYMENT' | 'COMPLIANCE' | 'TASK';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type Status = 'OPEN' | 'IN_PROGRESS' | 'AWAITING_APPROVAL' | 'RESOLVED' | 'CLOSED';

export const ITEM_TYPES: ItemType[] = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'COMPLIANCE', 'TASK'];
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'RESOLVED', 'CLOSED'];

export interface Ref { id: string; name: string }

export interface Item {
  id: string;
  title: string;
  description: string;
  type: ItemType;
  priority: Priority;
  status: Status;
  team: Ref;
  assignee: Ref | null;
  createdBy: Ref;
  dueDate: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** What the SERVER says the current user may do. The UI only renders it; the API enforces it. */
export interface ItemDetail extends Item {
  allowed: { edit: boolean; comment: boolean; claim: boolean; transitions: Status[] };
}

export interface ActivityEvent {
  id: string;
  type: 'CREATED' | 'STATUS_CHANGED' | 'ASSIGNED' | 'PRIORITY_CHANGED' | 'FIELDS_UPDATED' | 'COMMENT_ADDED';
  from: string | null;
  to: string | null;
  actor: Ref;
  createdAt: string;
}

export interface Comment { id: string; body: string; author: Ref; createdAt: string }

export interface Me {
  id: string;
  name: string;
  email: string;
  memberships: { teamId: string; teamName: string; role: Role }[];
}

export interface ListFilters {
  view?: 'assigned_to_me' | 'unassigned_urgent' | 'awaiting_my_approval';
  q?: string;
  status?: Status | '';
  priority?: Priority | '';
  type?: ItemType | '';
  teamId?: string;
}
