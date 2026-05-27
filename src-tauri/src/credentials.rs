use crate::asr::AsrProviderId;
use keyring::Entry;
use thiserror::Error;

const SERVICE_NAME: &str = "intervox-asr";
const LEGACY_SERVICE_NAME: &str = "video-dubber-asr";

#[derive(Debug, Default)]
pub struct CredentialStore;

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error("凭据不能为空。")]
    EmptySecret,
    #[error("系统安全存储不可用：{0}")]
    Keyring(#[from] keyring::Error),
}

impl CredentialStore {
    pub fn save(&self, provider: AsrProviderId, secret: String) -> Result<(), CredentialError> {
        let trimmed = secret.trim();
        if trimmed.is_empty() {
            return Err(CredentialError::EmptySecret);
        }

        let entry = Entry::new(SERVICE_NAME, provider.as_keyring_account())?;
        entry.set_password(trimmed)?;
        Ok(())
    }

    pub fn exists(&self, provider: AsrProviderId) -> Result<bool, CredentialError> {
        if provider == AsrProviderId::LocalWhisper {
            return Ok(true);
        }

        Ok(self.get(provider)?.is_some())
    }

    pub fn get(&self, provider: AsrProviderId) -> Result<Option<String>, CredentialError> {
        if provider == AsrProviderId::LocalWhisper {
            return Ok(None);
        }

        let account = provider.as_keyring_account();
        if let Some(secret) = Self::get_from_service(SERVICE_NAME, account)? {
            return Ok(Some(secret));
        }

        Self::get_from_service(LEGACY_SERVICE_NAME, account)
    }

    fn get_from_service(
        service_name: &'static str,
        account: &'static str,
    ) -> Result<Option<String>, CredentialError> {
        let entry = Entry::new(service_name, account)?;
        match entry.get_password() {
            Ok(secret) if secret.trim().is_empty() => Ok(None),
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(CredentialError::Keyring(error)),
        }
    }
}
