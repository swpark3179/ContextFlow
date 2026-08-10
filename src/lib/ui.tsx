/**
 * The design expresses interaction states as `style-hover` / `style-focus`
 * attributes on inline-styled elements. These wrappers are the React equivalent
 * so the ported markup keeps its styles inline and readable next to the source.
 */
import {
  forwardRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

type BoxProps = HTMLAttributes<HTMLDivElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

export const Box = forwardRef<HTMLDivElement, BoxProps>(function Box(
  { style, hover, onMouseEnter, onMouseLeave, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <div
      ref={ref}
      {...rest}
      style={on && hover ? { ...style, ...hover } : style}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hover) setOn(false);
        onMouseLeave?.(e);
      }}
    />
  );
});

type SpanProps = HTMLAttributes<HTMLSpanElement> & {
  style?: CSSProperties;
  hover?: CSSProperties;
};

export function Span({ style, hover, onMouseEnter, onMouseLeave, ...rest }: SpanProps) {
  const [on, setOn] = useState(false);
  return (
    <span
      {...rest}
      style={on && hover ? { ...style, ...hover } : style}
      onMouseEnter={(e) => {
        if (hover) setOn(true);
        onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (hover) setOn(false);
        onMouseLeave?.(e);
      }}
    />
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { style, focusStyle, onFocus, onBlur, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <input
      ref={ref}
      {...rest}
      style={on && focusStyle ? { ...style, ...focusStyle } : style}
      onFocus={(e) => {
        setOn(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setOn(false);
        onBlur?.(e);
      }}
    />
  );
});

type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  style?: CSSProperties;
  focusStyle?: CSSProperties;
};

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { style, focusStyle, onFocus, onBlur, ...rest },
  ref,
) {
  const [on, setOn] = useState(false);
  return (
    <textarea
      ref={ref}
      {...rest}
      style={on && focusStyle ? { ...style, ...focusStyle } : style}
      onFocus={(e) => {
        setOn(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setOn(false);
        onBlur?.(e);
      }}
    />
  );
});

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />;
}
