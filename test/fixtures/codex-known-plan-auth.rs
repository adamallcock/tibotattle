// Synthetic fixture matching the public KnownPlan method shape. It is not a
// buildable Rust module; the drift checker deliberately reads only these two
// reviewed match expressions.
impl KnownPlan {
    pub fn display_name(self) -> &'static str {
        match self {
            Self::Free => "Free",
            Self::Go => "Go",
            Self::Plus => "Plus",
            Self::Pro => "Pro",
            Self::ProLite => "Pro Lite",
            Self::Team => "Team",
            Self::SelfServeBusinessProLite => "Self Serve Business ProLite",
            Self::SelfServeBusinessUsageBased => "Self Serve Business Usage Based",
            Self::Business => "Business",
            Self::Ent26 => "Enterprise",
            Self::EnterpriseCbpAutomation => "Enterprise (Automation)",
            Self::EnterpriseCbpUsageBased => "Enterprise CBP Usage Based",
            Self::Enterprise => "Enterprise",
            Self::Edu => "Edu",
            Self::EduPlus => "Edu Plus",
            Self::EduPro => "Edu Pro",
        }
    }

    pub fn raw_value(self) -> &'static str {
        match self {
            Self::Free => "free",
            Self::Go => "go",
            Self::Plus => "plus",
            Self::Pro => "pro",
            Self::ProLite => "prolite",
            Self::Team => "team",
            Self::SelfServeBusinessProLite => "self_serve_business_prolite",
            Self::SelfServeBusinessUsageBased => "self_serve_business_usage_based",
            Self::Business => "business",
            Self::Ent26 => "ent26",
            Self::EnterpriseCbpAutomation => "enterprise_cbp_automation",
            Self::EnterpriseCbpUsageBased => "enterprise_cbp_usage_based",
            Self::Enterprise => "enterprise",
            Self::Edu => "edu",
            Self::EduPlus => "edu_plus",
            Self::EduPro => "edu_pro",
        }
    }
}
