import { useCallback, useContext, useEffect } from "react";
import api, { openApi } from "../../services/api";
import { Mutex } from "async-mutex";
import { SocketContext } from "../../context/Socket/SocketContext";
import {
  clearAllCachedSettings,
  clearCachedSettingsKey,
  setCachedSettingValue
} from "../../helpers/settingsCache";

const cachedSettingsMutex = new Mutex();
const safeSettingsKeys = new Set([
  "groupsTab",
  "CheckMsgIsGroup",
  "soundGroupNotifications",
  "tagsMode"
]);

const useSettings = () => {
  // all the functions below are wrapped in useCallback so their identity is
  // stable across renders: they are commonly used as useEffect dependencies
  // and unstable identities make those effects re-run on every render
  const getSettingFromApi = useCallback(async (key, defaultValue = "") => {
    if (!api.defaults.headers.Authorization) {
      return defaultValue;
    }
    const { data } = await api.request({
      url: `/settings/${key}`,
      method: "GET"
    });

    if (!data) {
      return defaultValue;
    }

    setCachedSettingValue(key, data);

    return data;
  }, []);

  const get = useCallback(async key => {
    const { data } = await api.request({
      url: `/settings/${key}`,
      method: "GET"
    });
    return data;
  }, []);

  const getAll = useCallback(async params => {
    const { data } = await api.request({
      url: "/settings",
      method: "GET",
      params
    });
    return data;
  }, []);

  const update = useCallback(async data => {
    const { data: responseData } = await api.request({
      url: `/settings/${data.key}`,
      method: "PUT",
      data: {
        value: data.value
      }
    });

    setCachedSettingValue(data.key, data.value);

    return responseData;
  }, []);

  const getPublicSetting = useCallback(async key => {
    const { data } = await openApi.request({
      url: `/public-settings/${key}`,
      method: "GET"
    });
    return data;
  }, []);

  const getCachedSetting = useCallback(
    async (key, defaultValue = "") => {
      return await cachedSettingsMutex.runExclusive(() => {
        const cached = sessionStorage.getItem(key);
        const timestamp = sessionStorage.getItem(`${key}_timestamp`);
        if (cached) {
          // check if timestamp is older than 10 minutes
          if (timestamp && Date.now() - timestamp > 10 * 60 * 1000) {
            clearCachedSettingsKey(key);
          } else {
            return JSON.parse(cached);
          }
        }
        return getSettingFromApi(key, defaultValue);
      });
    },
    [getSettingFromApi]
  );

  const getSetting = useCallback(
    async (key, defaultValue = "") => {
      if (safeSettingsKeys.has(key)) {
        return getCachedSetting(key, defaultValue);
      }

      return getSettingFromApi(key, defaultValue);
    },
    [getCachedSetting, getSettingFromApi]
  );

  const socketManager = useContext(SocketContext);

  useEffect(() => {
    if (!socketManager) {
      return () => {};
    }

    const socket = socketManager.GetSocket();

    const onSettingsUseSettings = data => {
      if (typeof data?.key !== "string" || !data.key) {
        return;
      }

      setCachedSettingValue(data.key, data.value);
    };

    socket.on("settings", onSettingsUseSettings);

    let unsubscribeWsConnectionIssue = null;
    if (typeof socketManager.subscribeWsConnectionIssue === "function") {
      unsubscribeWsConnectionIssue = socketManager.subscribeWsConnectionIssue(
        active => {
          if (active) {
            clearAllCachedSettings();
          }
        }
      );
    }

    return () => {
      if (typeof unsubscribeWsConnectionIssue === "function") {
        unsubscribeWsConnectionIssue();
      }
      socket.disconnect();
    };
  }, [socketManager]);

  return {
    get,
    getAll,
    getPublicSetting,
    getSetting,
    getCachedSetting,
    update
  };
};

export default useSettings;
