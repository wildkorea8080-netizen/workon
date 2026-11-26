import OrganizationManager from '@/components/admin/OrganizationManager';
import OrgApiKeysPanel from '@/components/admin/OrgApiKeysPanel';
import DormantLockPanel from '@/components/admin/DormantLockPanel';
import OrgSsoPanel from '@/components/admin/OrgSsoPanel';
import LibrarySharesPanel from '@/components/admin/LibrarySharesPanel';
import WebSearchPanel from '@/components/admin/WebSearchPanel';
import BudgetAlertsPanel from '@/components/admin/BudgetAlertsPanel';

export default function AdminOrganizationPage() {
  return (
    <>
      <OrganizationManager />
      <BudgetAlertsPanel />
      <DormantLockPanel />
      <WebSearchPanel />
      <OrgSsoPanel />
      <LibrarySharesPanel />
      <OrgApiKeysPanel />
    </>
  );
}
