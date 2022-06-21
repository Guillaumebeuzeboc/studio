// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import {
  Dropdown,
  IDropdownOption,
  IDropdownStyles,
  ISelectableOption,
  useTheme,
} from "@fluentui/react";
import PushPinIcon from "@mui/icons-material/PushPin";
import {
  ListItem,
  ListItemIcon,
  ListItemText,
  styled as muiStyled,
  ListItemButton,
  Typography,
} from "@mui/material";
import produce from "immer";
import { compact, set, uniq } from "lodash";
import { useCallback, useEffect, useMemo } from "react";
import { List, AutoSizer, ListRowProps } from "react-virtualized";

import { filterMap } from "@foxglove/den/collection";
import { useDataSourceInfo } from "@foxglove/studio-base/PanelAPI";
import EmptyState from "@foxglove/studio-base/components/EmptyState";
import { LegacyInput } from "@foxglove/studio-base/components/LegacyStyledComponents";
import Panel from "@foxglove/studio-base/components/Panel";
import { usePanelContext } from "@foxglove/studio-base/components/PanelContext";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import { SettingsTreeAction } from "@foxglove/studio-base/components/SettingsTreeEditor/types";
import Stack from "@foxglove/studio-base/components/Stack";
import helpContent from "@foxglove/studio-base/panels/diagnostics/DiagnosticSummary.help.md";
import useDiagnostics from "@foxglove/studio-base/panels/diagnostics/useDiagnostics";
import { usePanelSettingsTreeUpdate } from "@foxglove/studio-base/providers/PanelSettingsEditorContextProvider";
import { SaveConfig } from "@foxglove/studio-base/types/panels";
import { DIAGNOSTIC_TOPIC } from "@foxglove/studio-base/util/globalConstants";
import toggle from "@foxglove/studio-base/util/toggle";

import { buildSummarySettingsTree } from "./settings";
import {
  DiagnosticSummaryConfig,
  DiagnosticInfo,
  DiagnosticStatusConfig,
  getDiagnosticsByLevel,
  filterAndSortDiagnostics,
  LEVEL_NAMES,
  KNOWN_LEVELS,
} from "./util";

type NodeRowProps = {
  info: DiagnosticInfo;
  isPinned: boolean;
  onClick: (info: DiagnosticInfo) => void;
  onClickPin: (info: DiagnosticInfo) => void;
};

const MESSAGE_COLORS: { [key: string]: string } = {
  ok: "success.main",
  warn: "warning.main",
  error: "error.main",
  stale: "text.secondary",
};

const StyledListItemButton = muiStyled(ListItemButton, {
  shouldForwardProp: (prop) => prop !== "isPinned",
})<{
  isPinned: boolean;
}>(({ isPinned, theme }) => ({
  gap: theme.spacing(1),

  ".MuiListItemIcon-root": {
    visibility: isPinned ? "visibile" : "hidden",
    minWidth: "auto",
  },
  ".MuiListItemText-root": {
    gap: theme.spacing(1),
    display: "flex",
  },
  "&:hover .MuiListItemIcon-root": {
    visibility: "visible",
  },
}));

const NodeRow = React.memo(function NodeRow(props: NodeRowProps) {
  const { info, isPinned, onClick, onClickPin } = props;

  const handleClick = useCallback(() => {
    onClick(info);
  }, [onClick, info]);

  const handleClickPin = useCallback(() => {
    onClickPin(info);
  }, [onClickPin, info]);

  const levelName = LEVEL_NAMES[info.status.level];

  return (
    <ListItem dense disablePadding data-test-diagnostic-row>
      <StyledListItemButton isPinned={isPinned} onClick={handleClick}>
        <ListItemIcon onClick={handleClickPin}>
          <PushPinIcon color={isPinned ? "inherit" : "disabled"} />
        </ListItemIcon>
        <ListItemText
          primary={info.displayName}
          secondary={info.status.message}
          secondaryTypographyProps={{
            color: MESSAGE_COLORS[levelName ?? "stale"],
          }}
        />
      </StyledListItemButton>
    </ListItem>
  );
});

type Props = {
  config: DiagnosticSummaryConfig;
  saveConfig: SaveConfig<DiagnosticSummaryConfig>;
};

const ALLOWED_DATATYPES: string[] = [
  "diagnostic_msgs/DiagnosticArray",
  "diagnostic_msgs/msg/DiagnosticArray",
  "ros.diagnostic_msgs.DiagnosticArray",
];

function DiagnosticSummary(props: Props): JSX.Element {
  const theme = useTheme();
  const dropdownStyles = useMemo(
    () =>
      ({
        root: {
          minWidth: "100px",
        },
        caretDownWrapper: {
          top: 0,
          lineHeight: 16,
          height: 16,
        },
        title: {
          backgroundColor: "transparent",
          fontSize: theme.fonts.small.fontSize,
          borderColor: theme.semanticColors.bodyDivider,
          lineHeight: 22,
          height: 22,
        },
        dropdownItemSelected: {
          fontSize: theme.fonts.small.fontSize,
          lineHeight: 22,
          height: 22,
          minHeight: 22,
        },
        dropdownItem: {
          lineHeight: 22,
          height: 22,
          minHeight: 22,
          fontSize: theme.fonts.small.fontSize,
        },
      } as Partial<IDropdownStyles>),
    [theme],
  );
  const { config, saveConfig } = props;
  const { topics } = useDataSourceInfo();
  const { minLevel, topicToRender, pinnedIds, hardwareIdFilter, sortByLevel = true } = config;
  const { openSiblingPanel } = usePanelContext();
  const updatePanelSettingsTree = usePanelSettingsTreeUpdate();

  const togglePinned = useCallback(
    (info: DiagnosticInfo) => {
      saveConfig({ pinnedIds: toggle(pinnedIds, info.id) });
    },
    [pinnedIds, saveConfig],
  );

  const showDetails = useCallback(
    (info: DiagnosticInfo) => {
      openSiblingPanel({
        panelType: "DiagnosticStatusPanel",
        siblingConfigCreator: () =>
          ({
            selectedHardwareId: info.status.hardware_id,
            selectedName: info.status.name,
            topicToRender,
            collapsedSections: [],
          } as DiagnosticStatusConfig),
        updateIfExists: true,
      });
    },
    [topicToRender, openSiblingPanel],
  );

  const renderRow = useCallback(
    // eslint-disable-next-line react/no-unused-prop-types
    ({ item, key }: ListRowProps & { item: DiagnosticInfo }) => {
      return (
        <NodeRow
          key={key}
          info={item}
          isPinned={pinnedIds.includes(item.id)}
          onClick={showDetails}
          onClickPin={togglePinned}
        />
      );
    },
    [pinnedIds, showDetails, togglePinned],
  );

  const hardwareFilter = (
    <LegacyInput
      style={{
        width: "100%",
        padding: "0",
        backgroundColor: "transparent",
        opacity: "0.5",
        marginLeft: "10px",
        fontSize: "12px",
      }}
      value={hardwareIdFilter}
      placeholder="Filter"
      onChange={(e) => saveConfig({ hardwareIdFilter: e.target.value })}
    />
  );

  // Filter down all topics to those that conform to our supported datatypes
  const availableTopics = useMemo(() => {
    const filtered = topics
      .filter((topic) => ALLOWED_DATATYPES.includes(topic.datatype))
      .map((topic) => topic.name);

    // Keeps only the first occurrence of each topic.
    return uniq([DIAGNOSTIC_TOPIC, ...filtered, topicToRender]);
  }, [topics, topicToRender]);

  const diagnostics = useDiagnostics(topicToRender);
  const summary = useMemo(() => {
    if (diagnostics.size === 0) {
      return (
        <EmptyState>
          Waiting for <code>{topicToRender}</code> messages
        </EmptyState>
      );
    }
    const pinnedNodes = filterMap(pinnedIds, (id) => {
      const [_, trimmedHardwareId, name] = id.split("|");
      if (name == undefined || trimmedHardwareId == undefined) {
        return;
      }
      const diagnosticsByName = diagnostics.get(trimmedHardwareId);
      return diagnosticsByName?.get(name);
    });

    const nodesByLevel = getDiagnosticsByLevel(diagnostics);
    const levels = Array.from(nodesByLevel.keys()).sort().reverse();
    const sortedNodes = sortByLevel
      ? ([] as DiagnosticInfo[]).concat(
          ...levels.map((level) =>
            filterAndSortDiagnostics(nodesByLevel.get(level) ?? [], hardwareIdFilter, pinnedIds),
          ),
        )
      : filterAndSortDiagnostics(
          ([] as DiagnosticInfo[]).concat(...nodesByLevel.values()),
          hardwareIdFilter,
          pinnedIds,
        );

    const nodes: DiagnosticInfo[] = [...compact(pinnedNodes), ...sortedNodes].filter(
      ({ status }) => status.level >= minLevel,
    );
    if (nodes.length === 0) {
      return ReactNull;
    }
    return (
      <AutoSizer>
        {({ height, width }) => (
          <List
            width={width}
            height={height}
            style={{ outline: "none" }}
            rowHeight={25}
            rowRenderer={(rowProps) => renderRow({ ...rowProps, item: nodes[rowProps.index]! })}
            rowCount={nodes.length}
            overscanRowCount={10}
          />
        )}
      </AutoSizer>
    );
  }, [diagnostics, hardwareIdFilter, pinnedIds, renderRow, sortByLevel, minLevel, topicToRender]);

  const actionHandler = useCallback(
    (action: SettingsTreeAction) => {
      if (action.action !== "update") {
        return;
      }

      const { path, value } = action.payload;
      saveConfig(produce<DiagnosticSummaryConfig>((draft) => set(draft, path.slice(1), value)));
    },
    [saveConfig],
  );

  useEffect(() => {
    updatePanelSettingsTree({
      actionHandler,
      roots: buildSummarySettingsTree(config, topicToRender, availableTopics),
    });
  }, [actionHandler, availableTopics, config, topicToRender, updatePanelSettingsTree]);

  const renderOption = (option: ISelectableOption | undefined) =>
    option ? (
      <Typography variant="inherit" color={MESSAGE_COLORS[option.text]}>
        &gt;= {option.text.toUpperCase()}
      </Typography>
    ) : (
      ReactNull
    );

  return (
    <Stack flex="auto">
      <PanelToolbar helpContent={helpContent}>
        <Dropdown
          styles={dropdownStyles}
          onRenderOption={renderOption}
          onRenderTitle={(options: IDropdownOption[] | undefined) =>
            options?.[0] ? renderOption(options[0]) : ReactNull
          }
          onChange={(_ev, option) => {
            if (option) {
              saveConfig({ minLevel: option.key as number });
            }
          }}
          options={KNOWN_LEVELS.map((key: number) => ({ key, text: LEVEL_NAMES[key] ?? "" }))}
          selectedKey={minLevel}
        />
        {hardwareFilter}
      </PanelToolbar>
      <Stack flex="auto">{summary}</Stack>
    </Stack>
  );
}

const defaultConfig: DiagnosticSummaryConfig = {
  minLevel: 0,
  pinnedIds: [],
  hardwareIdFilter: "",
  topicToRender: DIAGNOSTIC_TOPIC,
  sortByLevel: true,
};
export default Panel(
  Object.assign(DiagnosticSummary, {
    panelType: "DiagnosticSummary",
    defaultConfig,
  }),
);
