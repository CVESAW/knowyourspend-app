import AsyncStorage from "@react-native-async-storage/async-storage";

/** Key-value storage on the device (native). Nothing here is ever sent anywhere. */
export const kv = {
  get: (key: string) => AsyncStorage.getItem(key),
  set: (key: string, value: string) => AsyncStorage.setItem(key, value),
  remove: (key: string) => AsyncStorage.removeItem(key),
};
