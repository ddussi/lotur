"use server";

export async function echoAction(_previous, formData) {
  return String(formData.get("message") ?? "");
}
