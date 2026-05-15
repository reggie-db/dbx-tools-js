
export function tokenize(
    distinct = false,
    ...values: any[]
  ): string[] {
    const parts = values.flatMap(value => {
      if (value == null) {
        return [];
      }
  
      return String(value)
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .filter(Boolean);
    });
  
    return distinct ? [...new Set(parts)] : parts;
  }
  
  export function toUnderscoreCase(
    distinct = false,
    ...values: any[]
  ): string {
    return tokenize(distinct, ...values)
      .map(part => part.toLowerCase())
      .join("_");
  }
  
  
  export function toCamelCase(
    distinct = false,
    ...values: any[]
  ): string {
    const parts = tokenize(distinct, ...values);
  
    if (parts.length === 0) {
      return "";
    }
  
    return (
      parts[0].toLowerCase() +
      parts
        .slice(1)
        .map(
          part =>
            part.charAt(0).toUpperCase() +
            part.slice(1).toLowerCase(),
        )
        .join("")
    );
  }