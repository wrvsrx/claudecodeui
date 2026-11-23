import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import SetupForm from '@/modules/auth/SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind setup, login and onboarding. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { t } = useTranslation('auth');
  const { user, isLoading, authMode, needsSetup, error, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (!user && authMode !== 'standalone') {
    return (
      <AuthScreenLayout title={t('recovery.title')} description={t('recovery.description')} footerText={t('recovery.footerText')}>
        <div className="space-y-4">
          <AuthErrorAlert errorMessage={error ?? ''} />
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground hover:brightness-110"
          >
            {t('recovery.reload')}
          </button>
        </div>
      </AuthScreenLayout>
    );
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
