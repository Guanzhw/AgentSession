//! The family Library follows the server locale, as the 2.0 Intl comparator did.
use crate::{CoreError, Result};
use icu_collator::{
    Collator, CollatorBorrowed,
    options::{CollatorOptions, Strength},
};
use icu_locale_core::Locale;
use std::cmp::Ordering;

#[derive(Debug)]
pub(crate) struct LibraryCollation {
    identity: String,
    title: CollatorBorrowed<'static>,
    canonical: CollatorBorrowed<'static>,
}

impl LibraryCollation {
    pub(crate) fn system() -> Result<Self> {
        Self::for_locale(&system_locale()?)
    }

    pub(crate) fn for_locale(value: &str) -> Result<Self> {
        let locale: Locale = value.parse().map_err(|error| {
            CoreError::InvalidInput(format!(
                "invalid server collation locale {value:?}: {error}"
            ))
        })?;
        let mut options = CollatorOptions::default();
        options.strength = Some(Strength::Primary);
        let title = Collator::try_new(locale.clone().into(), options)
            .map_err(|error| CoreError::InvalidInput(format!("server title collation: {error}")))?;
        let canonical = Collator::try_new(locale.clone().into(), CollatorOptions::default())
            .map_err(|error| {
                CoreError::InvalidInput(format!("server identity collation: {error}"))
            })?;
        Ok(Self {
            // Bump alongside collation algorithm/data changes so old pages cannot resume
            // into a different ordering after a process restart or binary update.
            identity: format!("icu4x-2.2.1-data-2.2.0-v1:{locale}"),
            title,
            canonical,
        })
    }

    pub(crate) fn identity(&self) -> &str {
        &self.identity
    }

    pub(crate) fn title(&self, left: &str, right: &str) -> Ordering {
        self.title.compare(left, right)
    }

    pub(crate) fn canonical(&self, left: &str, right: &str) -> Ordering {
        self.canonical.compare(left, right)
    }
}

#[cfg(windows)]
fn system_locale() -> Result<String> {
    use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
    let mut buffer = [0u16; 85];
    // Read the same user default locale as ICU. The buffer is exclusively owned,
    // writable, and its length includes space for the API's terminating zero.
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if length == 0 {
        return Err(CoreError::InvalidInput(format!(
            "server locale lookup: {}",
            std::io::Error::last_os_error()
        )));
    }
    String::from_utf16(&buffer[..length as usize - 1])
        .map_err(|error| CoreError::InvalidInput(format!("server locale encoding: {error}")))
}

#[cfg(not(windows))]
fn system_locale() -> Result<String> {
    // This Rust process never calls setlocale. ICU's initial C-locale path reads
    // these variables in this order; LANGUAGE is a UI preference, not this contract.
    let value = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|key| std::env::var_os(key))
        .unwrap_or_else(|| "C".into());
    let value = value
        .into_string()
        .map_err(|_| CoreError::InvalidInput("server locale is not UTF-8".into()))?;
    Ok(posix_locale(&value))
}

#[cfg(any(not(windows), test))]
fn posix_locale(value: &str) -> String {
    let (base, modifier) = value
        .split_once('@')
        .map_or((value, None), |(base, modifier)| (base, Some(modifier)));
    let base = base.split('.').next().unwrap_or(base);
    // V8 maps ICU's en_US_POSIX process default to en-US for Intl.
    if base == "C" || base == "POSIX" {
        return "en-US".into();
    }
    if base.is_empty() {
        return "und".into();
    }
    let mut locale = base.replace('_', "-");
    if let Some(modifier) = modifier {
        // ICU preserves POSIX modifiers as variants, using private-use lvariant
        // for short variants such as @euro; @latin is not a script declaration.
        let valid_variant = (5..=8).contains(&modifier.len())
            || (modifier.len() == 4 && modifier.as_bytes()[0].is_ascii_digit());
        locale.push_str(if valid_variant { "-" } else { "-x-lvariant-" });
        locale.push_str(modifier);
    }
    locale
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_collation_preserves_chinese_and_english_locale_orders() {
        for (locale, expected) in [
            ("zh-CN", vec!["北京", "中山", "Alpha", "éclair"]),
            ("en-US", vec!["Alpha", "éclair", "中山", "北京"]),
        ] {
            let collation = LibraryCollation::for_locale(locale).unwrap();
            let mut titles = vec!["Alpha", "北京", "中山", "éclair"];
            titles.sort_by(|a, b| collation.title(a, b));
            assert_eq!(titles, expected);
            assert_eq!(collation.title("éclair", "ECLAIR"), Ordering::Equal);
            assert_eq!(collation.title("éclair", "e\u{301}clair"), Ordering::Equal);
            assert_eq!(collation.title("Item 10", "Item 2"), Ordering::Less);
            assert_eq!(collation.canonical("case-a", "case-A"), Ordering::Less);
        }
    }

    #[test]
    fn posix_locale_normalizes_installed_locale_names() {
        for (input, expected) in [
            ("zh_CN.UTF-8", "zh-CN"),
            ("en_US.utf8", "en-US"),
            ("C.UTF-8", "en-US"),
            ("POSIX", "en-US"),
            ("", "und"),
            ("sr_RS.UTF-8@latin", "sr-RS-latin"),
            ("en_US.UTF-8@euro", "en-US-x-lvariant-euro"),
            ("ca_ES.UTF-8@valencia", "ca-ES-valencia"),
        ] {
            assert_eq!(posix_locale(input), expected);
            LibraryCollation::for_locale(expected).unwrap();
        }
    }
}
