export const registrationModes = ["closed", "invite", "public"] as const;
export type RegistrationMode = (typeof registrationModes)[number];
export const defaultRegistrationMode: RegistrationMode = "public";
