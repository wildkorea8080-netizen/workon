import OrganizationManager from '@/components/admin/OrganizationManager';
import OrgApiKeysPanel from '@/components/admin/OrgApiKeysPanel';
import DormantLockPanel from '@/components/admin/DormantLockPanel';

export default function AdminOrganizationPage() {
  return (
    <>
      <OrganizationManager />
      <DormantLockPanel />
      <OrgApiKeysPanel />
    </>
  );
}
