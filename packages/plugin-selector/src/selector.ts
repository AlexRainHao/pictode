import { App, EventArgs, Konva, KonvaNode, util } from '@pictode/core';
import { EnabledCheck } from '@pictode/utils';

import { HightLightConfig, Options, RubberConfig, TransformerConfig } from './types';
import { getNodeRect, transformPoint } from './utils';

interface HightLightRect {
  rect: Konva.Rect;
  transformHandler: (...args: any) => any;
}

const TRANSFORM_CHANGE_STR = [
  'widthChange',
  'heightChange',
  'scaleXChange',
  'scaleYChange',
  'skewXChange',
  'skewYChange',
  'rotationChange',
  'offsetXChange',
  'offsetYChange',
  'transformsEnabledChange',
  'strokeWidthChange',
  'absoluteTransformChange',
];

export class Selector {
  public app: App;
  public selected: Map<number | string, KonvaNode>;
  public enabled: boolean;
  public multipleSelect: boolean;
  public hightLightConfig: HightLightConfig;
  public transformerConfig: TransformerConfig;
  public rubberConfig: RubberConfig;

  private transformer: Konva.Transformer;
  private rubberRect: Konva.Rect;
  private rubberStartPoint: util.Point = new util.Point(0, 0);
  private rubberEnable: boolean = false;
  private hightLightRects: Map<string, HightLightRect>;
  private innerPortal: Konva.Group;
  private currentLine?: Konva.Line;
  private lineAnchor: Konva.Rect;

  constructor(app: App, options: Options) {
    const { enabled, multipleSelect, transformer, hightLight, rubber } = options;
    this.app = app;
    this.selected = new Map();
    this.hightLightRects = new Map();
    this.enabled = enabled;
    this.multipleSelect = multipleSelect;
    this.transformerConfig = transformer;
    this.hightLightConfig = hightLight;
    this.rubberConfig = rubber;

    this.lineAnchor = new Konva.Rect({
      stroke: this.transformerConfig.anchorStroke,
      fill: this.transformerConfig.anchorFill ?? 'white',
      strokeWidth: this.transformerConfig.anchorStrokeWidth,
      dragDistance: 0,
      draggable: true,
      hitStrokeWidth: 10,
      cornerRadius: this.transformerConfig.anchorCornerRadius,
    });

    this.innerPortal = new Konva.Group({ name: 'inner_portal' });
    this.app.optionLayer.add(this.innerPortal);

    this.transformer = new Konva.Transformer({
      name: 'pictode:transformer',
      ...this.transformerConfig,
      shouldOverdrawWholeArea: false, // 空白区域是否支持鼠标事件
      flipEnabled: false,
    });
    this.transformer.anchorStyleFunc((anchor) => {
      if (
        ['middle-left', 'middle-right', 'top-center', 'bottom-center'].some((anchorName) =>
          anchor.hasName(anchorName),
        ) &&
        ([...this.selected.values()]?.[0] instanceof Konva.Text ||
          [...this.selected.values()]?.[0] instanceof Konva.Group ||
          this.selected.size > 1)
      ) {
        anchor.visible(false);
      }
      const setAnchorCursor = (cursor: string = '') => {
        const anchorStage = anchor.getStage();
        if (!anchorStage?.content) {
          return;
        }
        anchorStage.content.style.cursor = cursor;
      };
      anchor.on('mousedown', () => {
        this.enabled = false;
      });
      anchor.on('mouseup mouseout', () => {
        this.enabled = true;
      });
      anchor.on('mouseenter', () => {
        this.enabled = false;
        if (anchor.hasName('rotater')) {
          setAnchorCursor('grabbing');
        } else if (anchor.hasName('point')) {
          setAnchorCursor('pointer');
        }
      });
    });

    this.app.optionLayer.add(this.transformer);

    this.rubberRect = new Konva.Rect({
      name: 'pictode:rubber:rect',
      stroke: this.rubberConfig.stroke,
      fill: this.rubberConfig.fill,
      strokeWidth: this.rubberConfig.strokeWidth,
      strokeScaleEnabled: false,
    });
    this.app.optionLayer.add(this.rubberRect);

    this.transformer.on<'transformstart'>('transformstart', this.onTransformStart);
    this.transformer.on<'transformend'>('transformend', this.onTransformEnd);
    this.transformer.on<'dragstart'>('dragstart', this.onDragStart);
    this.transformer.on<'dragend'>('dragend', this.onDragEnd);

    this.app.on('mouse:down', this.onMouseDown);
    this.app.on('mouse:move', this.onMouseMove);
    this.app.on('mouse:up', this.onMouseUp);
    this.app.on('mouse:click', this.onMouseClick);
    this.app.on('mouse:out', this.onMouseOut);
  }

  private handleNodeRemoved = ({ target }: any): void => {
    this.cancelSelect(target);
    target.off('removed', this.handleNodeRemoved);
  };

  @EnabledCheck
  public select(...nodes: KonvaNode[]): void {
    if (util.shapeArrayEqual(nodes, [...this.selected.values()])) {
      return;
    }
    this.cancelSelect();
    this.transformer.nodes(
      nodes.filter((node) => {
        node.draggable(true);
        node.on<'removed'>('removed', this.handleNodeRemoved);
        this.selected.set(node.id(), node);
        return node !== this.rubberRect;
      }),
    );
    if (nodes.length > 1) {
      this.setHightRect(...nodes);
    } else if (nodes.length === 1 && nodes[0].className === 'Line') {
      this.currentLine = nodes[0] as Konva.Line;
      this.currentLine.on('transform dragmove', this.updateLineAnchor);
    }
    this.createLineAnchor();
    this.app.render();
    this.app.emit('selected:changed', { selected: [...this.selected.values()] });
  }

  @EnabledCheck
  public cancelSelect(...nodes: KonvaNode[]): void {
    if (this.selected.size === 0) {
      return;
    }
    if (nodes.length === 0) {
      nodes = [...this.selected.values()];
    }
    nodes.forEach((node) => {
      node.draggable(false);
      node.off('removed', this.handleNodeRemoved);
      this.selected.delete(node.id());
      if (node.className === 'Line') {
        this.innerPortal.removeChildren();
        this.currentLine?.off('transform dragmove', this.updateLineAnchor);
        this.currentLine = undefined;
      }
    });
    this.removeHightRect(...nodes);
    this.transformer.nodes([...this.selected.values()]);
    this.app.emit('selected:changed', { selected: [...this.selected.values()] });
  }

  @EnabledCheck
  public selectAll(): void {
    this.select(...this.app.mainLayer.getChildren());
  }

  public triggerSelector(enable?: boolean): void {
    if (enable === void 0) {
      this.enabled = !this.enabled;
    } else {
      this.enabled = enable;
    }
    if (!this.enabled) {
      this.rubberEnable = false;
    }
  }

  @EnabledCheck
  public isSelected(node: KonvaNode): boolean {
    return this.selected.has(node.id());
  }

  public getSelectClientRect(): {
    width: number;
    height: number;
    x: number;
    y: number;
  } {
    return this.transformer.getClientRect();
  }

  private createLineAnchor() {
    if (!this.currentLine) {
      return;
    }
    const points = this.currentLine.points(); // 获取线条的所有点
    // 创建所有锚点
    for (let index = 0; index < points.length; index += 2) {
      const anchor = this.lineAnchor.clone() as Konva.Rect;
      anchor.name(`${index}_anchor`);
      this.innerPortal.add(anchor);
      anchor.on('dragmove', ({ target }) => {
        if (!this.currentLine) {
          return;
        }
        const { x, y } = transformPoint(
          target.getPosition(),
          this.innerPortal.getAbsoluteTransform(),
          this.currentLine.getAbsoluteTransform(),
        );

        points[index] = x;
        points[index + 1] = y;
        this.currentLine.points(points);
      });
    }

    this.updateLineAnchor();
  }

  private setHightRect(...nodes: KonvaNode[]) {
    this.hightLightRects = nodes.reduce((hightRects, node) => {
      const rect = new Konva.Rect({
        name: `pictode:${node._id}:height:rect`,
        stroke: this.hightLightConfig.stroke,
        strokeWidth: this.hightLightConfig.strokeWidth,
        dash: this.hightLightConfig.dash,
        fillEnabled: false,
        strokeScaleEnabled: false,
      });
      this.setAbsoluteNodeRect(node, rect, this.hightLightConfig.padding ?? 0);
      this.app.optionLayer.add(rect);

      const transformHandler = () =>
        requestAnimationFrame(() => this.setAbsoluteNodeRect(node, rect, this.hightLightConfig.padding ?? 0));

      node.on(TRANSFORM_CHANGE_STR.join(' '), transformHandler);

      hightRects.set(node.id(), {
        rect,
        transformHandler,
      });
      return hightRects;
    }, new Map<string, HightLightRect>());
  }

  private removeHightRect(...nodes: KonvaNode[]) {
    nodes.forEach((node) => {
      const hightLight = this.hightLightRects.get(node.id());
      if (!hightLight) {
        return;
      }
      node.off(TRANSFORM_CHANGE_STR.join(' '), hightLight.transformHandler);
      hightLight.rect.remove();
      this.hightLightRects.delete(node.id());
    });
  }

  private setAbsoluteNodeRect(node: KonvaNode, rect: Konva.Rect, padding: number = 0): void {
    const { x, y, width, height } = getNodeRect(node, padding);
    rect.position({
      x: (x - this.app.stage.x()) / this.app.stage.scaleX(),
      y: (y - this.app.stage.y()) / this.app.stage.scaleY(),
    });
    rect.width(width / this.app.stage.scaleX());
    rect.height(height / this.app.stage.scaleY());
    rect.rotation(node.rotation());
  }

  private updateLineAnchor = (): void => {
    if (!this.currentLine || !this.innerPortal.hasChildren()) {
      return;
    }
    const points = this.currentLine.points();
    const anchorSize = this.transformerConfig.anchorSize ?? 10;
    for (const anchor of this.innerPortal.getChildren()) {
      const index = parseInt(anchor.name().split('_')[0], 10);
      if (!isNaN(index) && index < points.length) {
        const { x, y } = transformPoint(
          { x: points[index], y: points[index + 1] },
          this.currentLine.getAbsoluteTransform(),
          this.innerPortal.getAbsoluteTransform(),
        );
        anchor.position({ x, y });
        anchor.width(anchorSize);
        anchor.height(anchorSize);
        anchor.offsetX(anchorSize / 2);
        anchor.offsetY(anchorSize / 2);
      }
    }
  };

  private onTransformStart = (): void => {
    this.app.emit('node:transform:start', { nodes: [...this.selected.values()] });
    this.app.emit('node:update:before', { nodes: [...this.selected.values()] });
  };

  private onTransformEnd = (): void => {
    this.app.emit('node:transform:end', { nodes: [...this.selected.values()] });
    this.app.emit('node:updated', { nodes: [...this.selected.values()] });
  };

  private onDragStart = (): void => {
    this.app.stage.listening(false);

    this.app.emit('node:transform:start', { nodes: [...this.selected.values()] });
    this.app.emit('node:update:before', { nodes: [...this.selected.values()] });
  };

  private onDragEnd = (): void => {
    setTimeout(() => {
      this.app.stage.listening(true);
    }, 100);

    this.app.emit('node:transform:end', { nodes: [...this.selected.values()] });
    this.app.emit('node:updated', { nodes: [...this.selected.values()] });
  };

  private onMouseDown = ({ event }: EventArgs['mouse:down']): void => {
    if (!this.enabled || event.evt.button !== 0) {
      return;
    }
    if (event.target instanceof Konva.Stage) {
      this.cancelSelect();
      this.rubberStartPoint.clone(this.app.pointer);
      this.rubberRect.setPosition(this.rubberStartPoint);
      this.rubberRect.width(0);
      this.rubberRect.height(0);
      this.rubberRect.visible(false);
      this.rubberEnable = true;
    }
  };

  private onMouseMove = (): void => {
    if (!this.enabled) {
      return;
    }
    if (!this.rubberEnable) {
      return;
    }
    // 如果弹性框选可用，则改变弹性框的尺寸
    const position = new util.Point(
      Math.min(this.app.pointer.x, this.rubberStartPoint.x),
      Math.min(this.app.pointer.y, this.rubberStartPoint.y),
    );
    this.rubberRect.setPosition(position);
    this.rubberRect.width(Math.max(this.app.pointer.x, this.rubberStartPoint.x) - position.x);
    this.rubberRect.height(Math.max(this.app.pointer.y, this.rubberStartPoint.y) - position.y);
    this.rubberRect.visible(true);
  };

  private onMouseUp = ({ event }: EventArgs['mouse:up']): void => {
    if (!this.enabled || event.evt.button !== 0) {
      return; // 未启用时直接返回
    }

    if (this.rubberEnable) {
      const shapesInRubberRect = this.app.getShapesInArea(this.rubberRect);
      this.select(...shapesInRubberRect);
      this.rubberRect.visible(false);
      this.rubberEnable = false;
    }
  };

  private onMouseClick = ({ event }: EventArgs['mouse:click']): void => {
    if (!this.enabled || event.evt.button !== 0) {
      return; // 未启用时直接返回
    }

    if (event.target instanceof Konva.Stage || !event.target.attrs.id) {
      return; // 如果是舞台或者没有ID属性，直接返回
    }

    const topGroup = this.app.findTopGroup(event.target);
    const target = topGroup ?? event.target;
    // 如果同时按下了shift键则认为是多选模式
    if (event.evt.shiftKey && this.multipleSelect) {
      if (this.selected.has(target.attrs.id)) {
        this.cancelSelect(target);
      } else {
        this.select(...this.selected.values(), target);
      }
    } else {
      this.select(target);
    }
  };

  private onMouseOut = ({ event }: EventArgs['mouse:out']): void => {
    if (event.target instanceof Konva.Stage) {
      this.rubberEnable = false;
    }
  };

  public destroy(): void {
    this.transformer.off('transformstart', this.onTransformStart);
    this.transformer.off('transformend', this.onTransformEnd);
    this.transformer.off('dragstart', this.onDragStart);
    this.transformer.off('dragend', this.onDragEnd);
    this.app.off('mouse:down', this.onMouseDown);
    this.app.off('mouse:move', this.onMouseMove);
    this.app.off('mouse:up', this.onMouseUp);
    this.app.off('mouse:click', this.onMouseClick);
    this.app.off('mouse:out', this.onMouseOut);
    this.selected.clear();
    this.enabled = false;
    this.transformer.remove();
    this.rubberRect.remove();
    this.innerPortal.remove();
  }
}

export default Selector;
